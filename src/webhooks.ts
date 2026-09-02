import { isIP } from "node:net";
import { randomBytes } from "node:crypto";
import {
  ConfigurationError,
  NotFoundError,
  OutboundEventDeliveryError,
} from "./errors.js";
import type { SecretStore } from "./integration-store.js";
import type {
  ClaimOutboundEventDeliveryRecord,
  OutboundEventDeliveryClaim,
  Repository,
} from "./repository.js";
import {
  signedOutboundEventSink,
  type OutboundEventDeliveryData,
  type OutboundEventDeliveryStatus,
  type OutboundEventReceipt,
  type OutboundEventRetryPolicy,
} from "./outbound-events.js";
import type { GenerationEvent, GenerationEventType, UserScope } from "./types.js";
import { assertIdentifier, createId, errorMessage } from "./utils.js";

const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_MULTIPLIER = 2;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_WORKER_CONCURRENCY = 1;
const DEFAULT_WORKER_POLL_INTERVAL_MS = 500;

export const WEBHOOK_EVENT_TYPES = Object.freeze([
  "generation.created",
  "attempt.queued",
  "attempt.started",
  "steering.queued",
  "steering.applied",
  "output.delta",
  "part.started",
  "part.delta",
  "part.completed",
  "part.failed",
  "artifact.created",
  "workspace.started",
  "workspace.prepared",
  "preview.ready",
  "preview.failed",
  "quality.started",
  "quality.completed",
  "attempt.waiting",
  "task.created",
  "task.resolved",
  "attempt.interrupted",
  "attempt.succeeded",
  "attempt.failed",
  "attempt.cancelled",
  "generation.succeeded",
  "generation.failed",
  "generation.cancelled",
] as const satisfies readonly GenerationEventType[]);

export const DEFAULT_WEBHOOK_EVENTS = Object.freeze([
  "attempt.waiting",
  "task.created",
  "preview.ready",
  "preview.failed",
  "generation.succeeded",
  "generation.failed",
  "generation.cancelled",
] as const satisfies readonly GenerationEventType[]);

const webhookEventTypes = new Set<GenerationEventType>(WEBHOOK_EVENT_TYPES);

export type WebhookStatus = "active" | "paused";
export type WebhookEventSelection = "all" | readonly GenerationEventType[];

export interface WebhookConfig {
  /** Web-standard transport. Defaults to globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** CloudEvents source. Defaults to viby://webhooks. */
  readonly source?: string;
}

export interface WebhookData {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly events: WebhookEventSelection;
  readonly status: WebhookStatus;
  readonly keyId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface StoredWebhookData extends WebhookData {
  readonly secretRef: string;
  /** First durable event cursor eligible for automatic delivery. */
  readonly deliveryStartCursor: string;
}

export interface CreateWebhookInput {
  readonly name: string;
  readonly url: string;
  /** Omit for lifecycle events, or use "all" for the complete generation trace. */
  readonly events?: WebhookEventSelection;
  /** Omit to generate a 256-bit secret returned exactly once. */
  readonly signingSecret?: string;
}

export interface CreateWebhookResult {
  readonly webhook: WebhookData;
  readonly signingSecret: string;
}

export interface UpdateWebhookInput {
  readonly name?: string;
  readonly url?: string;
  readonly events?: WebhookEventSelection;
}

export interface RotateWebhookSecretResult {
  readonly webhook: WebhookData;
  readonly signingSecret: string;
}

export interface CreateWebhookRecord {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  /** Null means all event types. */
  readonly eventTypes: readonly GenerationEventType[] | null;
  readonly status: WebhookStatus;
  readonly keyId: string;
  readonly secretRef: string;
  readonly now: Date;
}

export interface UpdateWebhookRecord {
  readonly name: string;
  readonly url: string;
  readonly eventTypes: readonly GenerationEventType[] | null;
  readonly status: WebhookStatus;
  readonly now: Date;
}

export interface ReplaceWebhookSecretRecord {
  readonly keyId: string;
  readonly secretRef: string;
  readonly now: Date;
}

export interface ReplaceWebhookSecretResult {
  readonly webhook: StoredWebhookData;
  readonly replacedSecretRef: string;
}

export interface WebhookStore {
  createWebhook(scope: UserScope, input: CreateWebhookRecord): Promise<StoredWebhookData>;
  listWebhooks(scope: UserScope): Promise<readonly StoredWebhookData[]>;
  getWebhook(scope: UserScope, id: string): Promise<StoredWebhookData | null>;
  updateWebhook(
    scope: UserScope,
    id: string,
    input: UpdateWebhookRecord,
  ): Promise<StoredWebhookData>;
  replaceWebhookSecret(
    scope: UserScope,
    id: string,
    input: ReplaceWebhookSecretRecord,
  ): Promise<ReplaceWebhookSecretResult>;
  deleteWebhook(scope: UserScope, id: string): Promise<StoredWebhookData | null>;
  getWebhookDeliveryCursor(
    scope: UserScope,
    webhookId: string,
    generationId: string,
  ): Promise<string>;
  advanceWebhookDeliveryCursor(
    scope: UserScope,
    webhookId: string,
    generationId: string,
    cursor: string,
    now: Date,
  ): Promise<string>;
  /**
   * Optional global discovery primitive used by the durable webhook worker.
   * Custom persistence adapters may omit it while retaining explicit delivery.
   */
  findWebhookDeliveryWork?(now: Date): Promise<WebhookDeliveryWork | null>;
}

export interface WebhookDeliveryWork {
  readonly scope: UserScope;
  readonly webhookId: string;
  readonly generationId: string;
  readonly eventCursor: string;
}

export interface WebhookDeliveryOptions {
  readonly limit?: number;
  readonly retry?: OutboundEventRetryPolicy;
  readonly signal?: AbortSignal;
}

export interface WebhookDeliveryPage {
  readonly webhookId: string;
  readonly generationId: string;
  readonly deliveries: readonly OutboundEventReceipt[];
  readonly deadLetters: readonly OutboundEventDeliveryData[];
  readonly cursor: string;
  readonly hasMore: boolean;
  readonly retryAt: Date | null;
}

export interface WebhookDeliveryListOptions {
  readonly status?: OutboundEventDeliveryStatus;
}

export interface WebhookWorkerOptions {
  readonly id: string;
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  readonly delivery?: Omit<WebhookDeliveryOptions, "signal">;
}

export interface WebhookWorkerRunOptions {
  readonly signal?: AbortSignal;
}

interface NormalizedWebhookConfig {
  readonly fetch: typeof globalThis.fetch;
  readonly source: string;
}

interface NormalizedRetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
  readonly leaseMs: number;
}

interface NormalizedWebhookWorkerOptions {
  readonly id: string;
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly delivery: Omit<WebhookDeliveryOptions, "signal">;
}

/**
 * Discovers due webhook work across tenant scopes and drains it with the same
 * durable cursors, leases, retries, and dead letters used by explicit delivery.
 */
export class WebhookWorker {
  readonly id: string;
  readonly #repository: Repository;
  readonly #secrets: SecretStore;
  readonly #config: WebhookConfig;
  readonly #options: NormalizedWebhookWorkerOptions;
  readonly #controller = new AbortController();
  #runPromise: Promise<void> | null = null;
  #isRunning = false;

  constructor(
    repository: Repository,
    secrets: SecretStore | null,
    config: WebhookConfig | undefined,
    options: WebhookWorkerOptions,
  ) {
    if (!config || !secrets) {
      throw new ConfigurationError(
        "Durable webhook workers require events.webhooks and storage.secrets.",
      );
    }
    if (typeof repository.findWebhookDeliveryWork !== "function") {
      throw new ConfigurationError(
        "The configured persistence adapter does not support durable webhook worker discovery.",
      );
    }
    normalizeWebhookConfig(config);
    this.#repository = repository;
    this.#secrets = secrets;
    this.#config = config;
    this.#options = normalizeWebhookWorkerOptions(options);
    this.id = this.#options.id;
  }

  get running(): boolean {
    return this.#isRunning;
  }

  async runOnce(options: WebhookWorkerRunOptions = {}): Promise<boolean> {
    validateWebhookWorkerRunOptions(options);
    if (this.#runPromise) {
      throw new ConfigurationError("runOnce cannot be called while the webhook worker is running.");
    }
    const signal = combineAbortSignals(this.#controller.signal, options.signal);
    signal.throwIfAborted();
    return this.#deliverNext(signal);
  }

  run(options: WebhookWorkerRunOptions = {}): Promise<void> {
    validateWebhookWorkerRunOptions(options);
    if (this.#runPromise) return this.#runPromise;
    const runController = new AbortController();
    const signal = combineAbortSignals(
      combineAbortSignals(this.#controller.signal, options.signal),
      runController.signal,
    );
    this.#isRunning = true;
    this.#runPromise = Promise.all(
      Array.from({ length: this.#options.concurrency }, () => this.#runLane(signal)),
    )
      .then(() => undefined)
      .catch((error) => {
        if (!runController.signal.aborted) runController.abort(error);
        throw error;
      })
      .finally(() => {
        this.#isRunning = false;
        this.#runPromise = null;
      });
    return this.#runPromise;
  }

  async stop(): Promise<void> {
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(new DOMException("Webhook worker stopped.", "AbortError"));
    }
    await this.#runPromise?.catch((error) => {
      if (!isAbortError(error)) throw error;
    });
  }

  async #deliverNext(signal: AbortSignal): Promise<boolean> {
    const work = await this.#repository.findWebhookDeliveryWork!(new Date());
    if (!work) return false;
    const collection = new WebhookCollection(
      work.scope,
      this.#repository,
      this.#secrets,
      this.#config,
    );
    try {
      await collection.deliver(work.webhookId, work.generationId, {
        ...this.#options.delivery,
        signal,
      });
    } catch (error) {
      // Delivery failures are already persisted with retry or dead-letter state.
      if (!(error instanceof OutboundEventDeliveryError)) throw error;
    }
    return true;
  }

  async #runLane(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        const worked = await this.#deliverNext(signal);
        if (!worked) await waitForPoll(this.#options.pollIntervalMs, signal);
      }
    } catch (error) {
      if (!signal.aborted && !isAbortError(error)) throw error;
    }
  }
}

export class WebhookCollection {
  readonly #scope: UserScope;
  readonly #repository: Repository;
  readonly #secrets: SecretStore | null;
  readonly #config: NormalizedWebhookConfig | null;

  constructor(
    scope: UserScope,
    repository: Repository,
    secrets: SecretStore | null,
    config: WebhookConfig | undefined,
  ) {
    this.#scope = scope;
    this.#repository = repository;
    this.#secrets = secrets;
    this.#config = config === undefined ? null : normalizeWebhookConfig(config);
  }

  async create(input: CreateWebhookInput): Promise<CreateWebhookResult> {
    const { secrets } = this.#ready();
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("Webhook input must be an object.");
    }
    const signingSecret = normalizeSigningSecret(input.signingSecret ?? generatedSigningSecret());
    const secretRef = await secrets.put(this.#scope, {
      bytes: new TextEncoder().encode(signingSecret),
      purpose: "webhook-signing",
      expiresAt: null,
    });
    try {
      const webhook = await this.#repository.createWebhook(this.#scope, {
        id: createId(),
        name: normalizeWebhookName(input.name),
        url: normalizeWebhookUrl(input.url),
        eventTypes: normalizeWebhookEvents(input.events),
        status: "active",
        keyId: generatedKeyId(),
        secretRef,
        now: new Date(),
      });
      return Object.freeze({ webhook: publicWebhook(webhook), signingSecret });
    } catch (error) {
      await secrets.delete(this.#scope, secretRef).catch(() => undefined);
      throw error;
    }
  }

  async list(): Promise<readonly WebhookData[]> {
    this.#ready();
    return Object.freeze(
      (await this.#repository.listWebhooks(this.#scope)).map(publicWebhook),
    );
  }

  async get(id: string): Promise<WebhookData> {
    this.#ready();
    return publicWebhook(await this.#getStored(id));
  }

  async update(id: string, input: UpdateWebhookInput): Promise<WebhookData> {
    this.#ready();
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("Webhook update must be an object.");
    }
    if (input.name === undefined && input.url === undefined && input.events === undefined) {
      throw new ConfigurationError("Webhook update requires name, url, or events.");
    }
    const existing = await this.#getStored(id);
    const updated = await this.#repository.updateWebhook(this.#scope, existing.id, {
      name: input.name === undefined ? existing.name : normalizeWebhookName(input.name),
      url: input.url === undefined ? existing.url : normalizeWebhookUrl(input.url),
      eventTypes:
        input.events === undefined
          ? storedEventTypes(existing.events)
          : normalizeWebhookEvents(input.events),
      status: existing.status,
      now: new Date(),
    });
    return publicWebhook(updated);
  }

  pause(id: string): Promise<WebhookData> {
    return this.#setStatus(id, "paused");
  }

  resume(id: string): Promise<WebhookData> {
    return this.#setStatus(id, "active");
  }

  async rotateSecret(id: string): Promise<RotateWebhookSecretResult> {
    const { secrets } = this.#ready();
    const existing = await this.#getStored(id);
    const signingSecret = generatedSigningSecret();
    const secretRef = await secrets.put(this.#scope, {
      bytes: new TextEncoder().encode(signingSecret),
      purpose: "webhook-signing",
      expiresAt: null,
    });
    try {
      const replaced = await this.#repository.replaceWebhookSecret(this.#scope, existing.id, {
        keyId: generatedKeyId(),
        secretRef,
        now: new Date(),
      });
      await secrets.delete(this.#scope, replaced.replacedSecretRef);
      return Object.freeze({ webhook: publicWebhook(replaced.webhook), signingSecret });
    } catch (error) {
      await secrets.delete(this.#scope, secretRef).catch(() => undefined);
      throw error;
    }
  }

  async delete(id: string): Promise<boolean> {
    const { secrets } = this.#ready();
    const deleted = await this.#repository.deleteWebhook(
      this.#scope,
      assertIdentifier(id, "Webhook id"),
    );
    if (!deleted) return false;
    await secrets.delete(this.#scope, deleted.secretRef);
    return true;
  }

  async deliver(
    webhookId: string,
    generationId: string,
    options: WebhookDeliveryOptions = {},
  ): Promise<WebhookDeliveryPage> {
    const { secrets, config } = this.#ready();
    if (!options || typeof options !== "object") {
      throw new ConfigurationError("Webhook delivery options must be an object.");
    }
    const webhook = await this.#getStored(webhookId);
    if (webhook.status !== "active") {
      throw new ConfigurationError(`Webhook ${webhook.id} is paused.`);
    }
    const generation = await this.#repository.getGeneration(
      this.#scope,
      assertIdentifier(generationId, "Generation id"),
    );
    if (!generation) throw new NotFoundError("Generation");
    const secret = await secrets.get(this.#scope, webhook.secretRef);
    if (!secret) throw new ConfigurationError(`Webhook ${webhook.id} signing secret is unavailable.`);
    const retry = normalizeRetryPolicy(options.retry);
    const limit = normalizeLimit(options.limit);
    const sinkId = webhookSinkId(webhook.id);
    const sink = signedOutboundEventSink({
      id: sinkId,
      secret,
      keyId: webhook.keyId,
      source: config.source,
      send: async (outbound) => {
        const response = await config.fetch(webhook.url, {
          method: "POST",
          headers: outbound.headers,
          body: outbound.body,
          redirect: "error",
          ...(outbound.signal ? { signal: outbound.signal } : {}),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`Webhook endpoint returned HTTP ${response.status}.`);
        }
        await response.body?.cancel().catch(() => undefined);
      },
    });
    let cursor = await this.#repository.getWebhookDeliveryCursor(
      this.#scope,
      webhook.id,
      generation.id,
    );
    const deliveries: OutboundEventReceipt[] = [];
    const deadLetters: OutboundEventDeliveryData[] = [];
    let retryAt: Date | null = null;
    let processed = 0;

    const pending = await this.#repository.listOutboundEventDeliveries(
      this.#scope,
      generation.id,
      sinkId,
      "pending",
    );
    for (const delivery of pending) {
      if (processed >= limit || BigInt(delivery.eventCursor) > BigInt(cursor)) break;
      const event = await this.#repository.getGenerationEvent(
        this.#scope,
        generation.id,
        delivery.eventCursor,
      );
      if (!event) continue;
      const result = await this.#deliverEvent(
        webhook,
        event,
        generation.chatId,
        sink,
        retry,
        cursor,
        options.signal,
      );
      processed += 1;
      if (result.receipt) deliveries.push(result.receipt);
      if (result.deadLetter) deadLetters.push(result.deadLetter);
      if (result.retryAt) {
        retryAt = result.retryAt;
        break;
      }
    }

    const selected = storedEventTypes(webhook.events);
    let pageCount = 0;
    let requestedPageLimit = 0;
    if (retryAt === null && processed < limit) {
      requestedPageLimit = limit - processed;
      const page = await this.#repository.listGenerationEvents(
        this.#scope,
        generation.id,
        cursor,
        requestedPageLimit,
      );
      pageCount = page.length;
      for (const event of page) {
        options.signal?.throwIfAborted();
        if (selected !== null && !selected.includes(event.type)) {
          cursor = await this.#repository.advanceWebhookDeliveryCursor(
            this.#scope,
            webhook.id,
            generation.id,
            event.cursor,
            new Date(),
          );
          continue;
        }
        const result = await this.#deliverEvent(
          webhook,
          event,
          generation.chatId,
          sink,
          retry,
          cursor,
          options.signal,
        );
        if (result.receipt) deliveries.push(result.receipt);
        if (result.deadLetter) deadLetters.push(result.deadLetter);
        if (result.retryAt) {
          retryAt = result.retryAt;
          break;
        }
        cursor = await this.#repository.advanceWebhookDeliveryCursor(
          this.#scope,
          webhook.id,
          generation.id,
          event.cursor,
          new Date(),
        );
      }
    }

    return Object.freeze({
      webhookId: webhook.id,
      generationId: generation.id,
      deliveries: Object.freeze(deliveries),
      deadLetters: Object.freeze(deadLetters),
      cursor,
      hasMore: retryAt !== null || (requestedPageLimit > 0 && pageCount === requestedPageLimit),
      retryAt,
    });
  }

  async deliveries(
    webhookId: string,
    generationId: string,
    options: WebhookDeliveryListOptions = {},
  ): Promise<readonly OutboundEventDeliveryData[]> {
    this.#ready();
    const webhook = await this.#getStored(webhookId);
    const generation = await this.#repository.getGeneration(
      this.#scope,
      assertIdentifier(generationId, "Generation id"),
    );
    if (!generation) throw new NotFoundError("Generation");
    return this.#repository.listOutboundEventDeliveries(
      this.#scope,
      generation.id,
      webhookSinkId(webhook.id),
      options.status,
    );
  }

  async redrive(
    webhookId: string,
    generationId: string,
    cursor: string,
  ): Promise<OutboundEventDeliveryData> {
    this.#ready();
    const webhook = await this.#getStored(webhookId);
    const generation = await this.#repository.getGeneration(
      this.#scope,
      assertIdentifier(generationId, "Generation id"),
    );
    if (!generation) throw new NotFoundError("Generation");
    return this.#repository.redriveOutboundEventDelivery(
      this.#scope,
      generation.id,
      normalizeRedriveCursor(cursor),
      webhookSinkId(webhook.id),
    );
  }

  async #deliverEvent(
    webhook: StoredWebhookData,
    event: GenerationEvent,
    chatId: string,
    sink: ReturnType<typeof signedOutboundEventSink>,
    retry: NormalizedRetryPolicy,
    cursor: string,
    signal: AbortSignal | undefined,
  ): Promise<{
    readonly receipt: OutboundEventReceipt | null;
    readonly deadLetter: OutboundEventDeliveryData | null;
    readonly retryAt: Date | null;
  }> {
    signal?.throwIfAborted();
    const claimInput: ClaimOutboundEventDeliveryRecord = {
      generationId: event.generationId,
      eventCursor: event.cursor,
      sinkId: sink.id,
      leaseToken: createId(),
      leaseMs: retry.leaseMs,
      maxAttempts: retry.maxAttempts,
    };
    const claim = await this.#repository.claimOutboundEventDelivery(this.#scope, claimInput);
    if (!claim) {
      const existing = await this.#repository.getOutboundEventDelivery(
        this.#scope,
        event.generationId,
        event.cursor,
        sink.id,
      );
      if (!existing) {
        throw new ConfigurationError(`Webhook event ${event.cursor} could not be claimed.`);
      }
      if (existing.status === "delivered") {
        return { receipt: null, deadLetter: null, retryAt: null };
      }
      if (existing.status === "dead_lettered") {
        return { receipt: null, deadLetter: existing, retryAt: null };
      }
      return {
        receipt: null,
        deadLetter: null,
        retryAt: existing.status === "delivering" ? existing.leaseExpiresAt : existing.nextAttemptAt,
      };
    }
    try {
      const receipt = await sink.deliver(event, {
        ...this.#scope,
        chatId,
        generationId: event.generationId,
        ...(signal ? { signal } : {}),
      });
      await this.#repository.completeOutboundEventDelivery(this.#scope, claim, receipt.deliveredAt);
      return { receipt, deadLetter: null, retryAt: null };
    } catch (error) {
      const failed = await this.#failDelivery(claim, retry, error);
      throw new OutboundEventDeliveryError(
        sink.id,
        `${event.generationId}:${event.cursor}`,
        event.cursor,
        cursor,
        failed,
        { cause: error },
      );
    }
  }

  async #failDelivery(
    claim: OutboundEventDeliveryClaim,
    retry: NormalizedRetryPolicy,
    error: unknown,
  ): Promise<OutboundEventDeliveryData | null> {
    try {
      return await this.#repository.failOutboundEventDelivery(this.#scope, {
        generationId: claim.delivery.generationId,
        eventCursor: claim.delivery.eventCursor,
        sinkId: claim.delivery.sinkId,
        leaseToken: claim.leaseToken,
        error: errorMessage(error),
        retryDelayMs: retryDelay(retry, claim.delivery.attemptCount),
      });
    } catch {
      return this.#repository.getOutboundEventDelivery(
        this.#scope,
        claim.delivery.generationId,
        claim.delivery.eventCursor,
        claim.delivery.sinkId,
      ).catch(() => null);
    }
  }

  async #setStatus(id: string, status: WebhookStatus): Promise<WebhookData> {
    this.#ready();
    const existing = await this.#getStored(id);
    if (existing.status === status) return publicWebhook(existing);
    const updated = await this.#repository.updateWebhook(this.#scope, existing.id, {
      name: existing.name,
      url: existing.url,
      eventTypes: storedEventTypes(existing.events),
      status,
      now: new Date(),
    });
    return publicWebhook(updated);
  }

  async #getStored(id: string): Promise<StoredWebhookData> {
    const webhook = await this.#repository.getWebhook(
      this.#scope,
      assertIdentifier(id, "Webhook id"),
    );
    if (!webhook) throw new NotFoundError("Webhook");
    return webhook;
  }

  #ready(): { readonly secrets: SecretStore; readonly config: NormalizedWebhookConfig } {
    if (!this.#config || !this.#secrets) {
      throw new ConfigurationError(
        "Durable webhooks are not configured. Add events.webhooks and storage.secrets.",
      );
    }
    return { secrets: this.#secrets, config: this.#config };
  }
}

function publicWebhook(webhook: StoredWebhookData): WebhookData {
  return Object.freeze({
    id: webhook.id,
    name: webhook.name,
    url: webhook.url,
    events: webhook.events === "all" ? "all" : Object.freeze([...webhook.events]),
    status: webhook.status,
    keyId: webhook.keyId,
    createdAt: webhook.createdAt,
    updatedAt: webhook.updatedAt,
  });
}

function storedEventTypes(events: WebhookEventSelection): readonly GenerationEventType[] | null {
  return events === "all" ? null : events;
}

function normalizeWebhookConfig(config: WebhookConfig): NormalizedWebhookConfig {
  if (!config || typeof config !== "object") {
    throw new ConfigurationError("events.webhooks must be an object.");
  }
  const fetchImplementation = config.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new ConfigurationError("events.webhooks requires a Web-standard fetch implementation.");
  }
  const source = config.source?.trim() || "viby://webhooks";
  if (source.length > 500) {
    throw new ConfigurationError("Webhook CloudEvents source cannot exceed 500 characters.");
  }
  return { fetch: fetchImplementation.bind(globalThis), source };
}

function normalizeWebhookName(value: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length < 1 || name.length > 100) {
    throw new ConfigurationError("Webhook name must contain between 1 and 100 characters.");
  }
  return name;
}

function normalizeWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("Webhook URL must be an absolute HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new ConfigurationError(
      "Webhook URL must use HTTPS without credentials or a fragment.",
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    isPrivateIp(hostname)
  ) {
    throw new ConfigurationError("Webhook URL cannot target a local or private network address.");
  }
  if (url.toString().length > 2_000) {
    throw new ConfigurationError("Webhook URL cannot exceed 2,000 characters.");
  }
  return url.toString();
}

function isPrivateIp(hostname: string): boolean {
  const version = isIP(hostname);
  if (version === 4) {
    const [a = 0, b = 0] = hostname.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (version === 6) {
    const normalized = hostname.toLowerCase();
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || /^fe[89ab]/.test(normalized);
  }
  return false;
}

function normalizeWebhookEvents(
  value: WebhookEventSelection | undefined,
): readonly GenerationEventType[] | null {
  if (value === undefined) return DEFAULT_WEBHOOK_EVENTS;
  if (value === "all") return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigurationError("Webhook events must be \"all\" or a non-empty array.");
  }
  const events = [...new Set(value)];
  for (const event of events) {
    if (!webhookEventTypes.has(event)) {
      throw new ConfigurationError(`Unsupported webhook event type: ${String(event)}`);
    }
  }
  return Object.freeze(events);
}

function normalizeSigningSecret(value: string): string {
  const secret = typeof value === "string" ? value.trim() : "";
  if (new TextEncoder().encode(secret).byteLength < 32 || secret.length > 500) {
    throw new ConfigurationError(
      "Webhook signing secret must contain between 32 and 500 UTF-8 bytes.",
    );
  }
  return secret;
}

function generatedSigningSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

function generatedKeyId(): string {
  return `whk_${createId().replaceAll("-", "")}`;
}

function webhookSinkId(id: string): string {
  return `webhook.${id}`;
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new ConfigurationError("Webhook delivery limit must be an integer between 1 and 500.");
  }
  return limit;
}

function normalizeCursor(value: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new ConfigurationError("Webhook event cursor must be an opaque integer string.");
  }
  return value;
}

function normalizeRedriveCursor(value: string): string {
  const cursor = normalizeCursor(value);
  if (cursor === "0") {
    throw new ConfigurationError("Webhook redrive cursor must identify a persisted event.");
  }
  return cursor;
}

function normalizeRetryPolicy(value: OutboundEventRetryPolicy | undefined): NormalizedRetryPolicy {
  const retry = value ?? {};
  return {
    maxAttempts: boundedInteger(retry.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, 100, "maxAttempts"),
    initialDelayMs: boundedInteger(
      retry.initialDelayMs,
      DEFAULT_INITIAL_DELAY_MS,
      0,
      24 * 60 * 60 * 1_000,
      "initialDelayMs",
    ),
    maxDelayMs: boundedInteger(
      retry.maxDelayMs,
      DEFAULT_MAX_DELAY_MS,
      0,
      7 * 24 * 60 * 60 * 1_000,
      "maxDelayMs",
    ),
    multiplier: boundedNumber(retry.multiplier, DEFAULT_MULTIPLIER, 1, 100, "multiplier"),
    leaseMs: boundedInteger(retry.leaseMs, DEFAULT_LEASE_MS, 1_000, 60 * 60 * 1_000, "leaseMs"),
  };
}

function retryDelay(retry: NormalizedRetryPolicy, attemptCount: number): number {
  return Math.min(
    retry.maxDelayMs,
    Math.round(retry.initialDelayMs * retry.multiplier ** Math.max(0, attemptCount - 1)),
  );
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new ConfigurationError(`Webhook retry ${label} is outside the supported range.`);
  }
  return normalized;
}

function boundedNumber(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized < minimum || normalized > maximum) {
    throw new ConfigurationError(`Webhook retry ${label} is outside the supported range.`);
  }
  return normalized;
}

function normalizeWebhookWorkerOptions(
  options: WebhookWorkerOptions,
): NormalizedWebhookWorkerOptions {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("Webhook worker options must be an object.");
  }
  const id = assertIdentifier(options.id, "Webhook worker id");
  const concurrency = options.concurrency ?? DEFAULT_WORKER_CONCURRENCY;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WORKER_POLL_INTERVAL_MS;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new ConfigurationError(
      "Webhook worker concurrency must be an integer between 1 and 32.",
    );
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 60_000) {
    throw new ConfigurationError(
      "Webhook worker pollIntervalMs must be an integer between 10 and 60000.",
    );
  }
  if (
    options.delivery !== undefined &&
    (!options.delivery || typeof options.delivery !== "object")
  ) {
    throw new ConfigurationError("Webhook worker delivery options must be an object.");
  }
  const delivery = Object.freeze({ ...(options.delivery ?? {}) });
  normalizeLimit(delivery.limit);
  normalizeRetryPolicy(delivery.retry);
  return { id, concurrency, pollIntervalMs, delivery };
}

function validateWebhookWorkerRunOptions(options: WebhookWorkerRunOptions): void {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("Webhook worker run options must be an object.");
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function combineAbortSignals(first: AbortSignal, second?: AbortSignal): AbortSignal {
  if (!second) return first;
  const controller = new AbortController();
  const abortFirst = () => abort(first.reason);
  const abortSecond = () => abort(second.reason);
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
    first.removeEventListener("abort", abortFirst);
    second.removeEventListener("abort", abortSecond);
  };
  if (first.aborted) abort(first.reason);
  else if (second.aborted) abort(second.reason);
  else {
    first.addEventListener("abort", abortFirst, { once: true });
    second.addEventListener("abort", abortSecond, { once: true });
  }
  return controller.signal;
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
