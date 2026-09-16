import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import type { Chat, Generation } from "./client.js";
import type { FrameworkId, GenerateInput } from "./types.js";

type ChatTrigger = "submit-message" | "regenerate-message";

/** The AI SDK request normalized by {@link createVibyAIChatHandler}. */
export interface VibyAIChatRequest {
  /** The original request, available to product-owned authorization and binding logic. */
  readonly request: Request;
  /** The AI SDK chat id. Managed Harness uses its thread id here. */
  readonly conversationId: string;
  readonly messages: readonly UIMessage[];
  readonly trigger: ChatTrigger;
  readonly messageId: string | undefined;
}

/** The Viby objects selected for one AI SDK turn. */
export interface VibyAIChatStartInput<Framework extends FrameworkId = FrameworkId> {
  readonly request: VibyAIChatRequest;
  readonly chat: Chat<Framework>;
  readonly generationInput: GenerateInput;
}

/** A Web-standard AI SDK endpoint backed by a Viby chat. */
export type VibyAIChatHandler = (request: Request) => Promise<Response>;

export interface VibyAIChatHandlerOptions<Framework extends FrameworkId = FrameworkId> {
  /**
   * Resolve the authorized Viby chat for this AI SDK conversation. The product
   * owns the thread-to-chat binding and authorization decision.
   */
  readonly resolveChat: (
    request: VibyAIChatRequest,
  ) => Chat<Framework> | Promise<Chat<Framework>>;
  /**
   * Converts an AI SDK turn into Viby's durable generation input. The default
   * uses the last user message's text parts as the prompt.
   */
  readonly createGenerationInput?: (
    request: VibyAIChatRequest,
  ) => GenerateInput | Promise<GenerateInput>;
  /**
   * Starts a generation after its input is built. Supply this when the product
   * persists an idempotent request-to-generation binding.
   */
  readonly startGeneration?: (
    input: VibyAIChatStartInput<Framework>,
  ) => Generation<Framework> | Promise<Generation<Framework>>;
}

class AIChatRequestError extends Error {}

/**
 * Creates an AI SDK UI-message endpoint for an authorized Viby chat.
 *
 * The handler turns Viby output events into UI message chunks. A request abort
 * cancels the active Viby generation so `stop()` has durable effect.
 */
export function createVibyAIChatHandler<Framework extends FrameworkId>(
  options: VibyAIChatHandlerOptions<Framework>,
): VibyAIChatHandler {
  if (!options || typeof options.resolveChat !== "function") {
    throw new TypeError("createVibyAIChatHandler requires resolveChat(request).");
  }
  if (
    options.createGenerationInput !== undefined
    && typeof options.createGenerationInput !== "function"
  ) {
    throw new TypeError("createGenerationInput must be a function.");
  }
  if (options.startGeneration !== undefined && typeof options.startGeneration !== "function") {
    throw new TypeError("startGeneration must be a function.");
  }

  return async (request) => {
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }

    let input: VibyAIChatRequest;
    try {
      input = await readRequest(request);
    } catch (error) {
      return invalidRequest(error);
    }

    const chat = await options.resolveChat(input);
    let generationInput: GenerateInput;
    try {
      generationInput = await (options.createGenerationInput ?? defaultGenerationInput)(input);
    } catch (error) {
      return invalidRequest(error);
    }

    let generation: Generation<Framework> | undefined;
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      if (!generation) return Promise.resolve();
      cancellation ??= generation.cancel("Cancelled by AI SDK client.").then(
        () => undefined,
        () => undefined,
      );
      return cancellation;
    };
    const onAbort = () => void cancel();
    request.signal.addEventListener("abort", onAbort);

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        try {
          generation = await (options.startGeneration ?? defaultStartGeneration)({
            request: input,
            chat,
            generationInput,
          });
          const messageMetadata = {
            viby: { chatId: chat.id, generationId: generation.id },
          };
          const textId = `${generation.id}:text`;
          let textOpen = false;
          const openText = () => {
            if (textOpen) return;
            textOpen = true;
            writer.write({ type: "text-start", id: textId });
          };
          const closeText = () => {
            if (!textOpen) return;
            textOpen = false;
            writer.write({ type: "text-end", id: textId });
          };

          writer.write({
            type: "start",
            messageId: generation.id,
            messageMetadata,
          });

          if (request.signal.aborted) {
            await cancel();
            writer.write({ type: "abort", reason: "Chat request cancelled." });
            return;
          }

          for await (const event of generation.stream({ signal: request.signal })) {
            switch (event.type) {
              case "output.delta":
                openText();
                writer.write({ type: "text-delta", id: textId, delta: event.data.delta });
                break;
              case "generation.succeeded":
                closeText();
                writer.write({ type: "finish", finishReason: "stop", messageMetadata });
                return;
              case "generation.failed":
                closeText();
                writer.write({ type: "error", errorText: event.data.error });
                return;
              case "generation.cancelled":
                closeText();
                writer.write({ type: "abort", reason: event.data.reason });
                return;
              case "attempt.waiting":
                closeText();
                writer.write({
                  type: "error",
                  errorText:
                    "This Viby generation is waiting for a task response. Resolve the task through Viby before continuing.",
                });
                return;
            }
          }

          writer.write({
            type: "error",
            errorText: "Viby generation stream ended without a terminal event.",
          });
        } catch (error) {
          if (request.signal.aborted) {
            writer.write({ type: "abort", reason: "Chat request cancelled." });
            return;
          }
          throw error;
        } finally {
          request.signal.removeEventListener("abort", onAbort);
        }
      },
    });

    return createUIMessageStreamResponse({ stream });
  };
}

const defaultStartGeneration = <Framework extends FrameworkId>(
  input: VibyAIChatStartInput<Framework>,
) => input.chat.start(input.generationInput);

const defaultGenerationInput = (request: VibyAIChatRequest): GenerateInput => {
  const message = [...request.messages].reverse().find((entry) => entry.role === "user");
  if (!message) throw new AIChatRequestError("AI SDK messages must include a user message.");
  const textParts = message.parts.filter(
    (part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text",
  );
  if (textParts.length !== message.parts.length) {
    throw new AIChatRequestError(
      "AI SDK file and custom parts require createGenerationInput(request).",
    );
  }
  const prompt = textParts.map((part) => part.text).join("\n").trim();
  if (!prompt) throw new AIChatRequestError("The latest AI SDK user message must contain text.");
  return { prompt };
};

const readRequest = async (request: Request): Promise<VibyAIChatRequest> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AIChatRequestError("AI SDK chat requests must contain JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AIChatRequestError("AI SDK chat request body must be an object.");
  }
  const value = body as Record<string, unknown>;
  const conversationId = stringValue(value.id, "id");
  if (!Array.isArray(value.messages)) {
    throw new AIChatRequestError("AI SDK chat request messages must be an array.");
  }
  if (value.trigger !== "submit-message" && value.trigger !== "regenerate-message") {
    throw new AIChatRequestError("AI SDK chat request trigger is invalid.");
  }
  if (value.messageId !== undefined && typeof value.messageId !== "string") {
    throw new AIChatRequestError("AI SDK chat request messageId must be a string.");
  }
  return {
    request,
    conversationId,
    messages: value.messages as UIMessage[],
    trigger: value.trigger,
    messageId: value.messageId as string | undefined,
  };
};

const stringValue = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new AIChatRequestError(`AI SDK chat request ${name} must be a non-empty string.`);
  }
  return value;
};

const invalidRequest = (error: unknown): Response =>
  Response.json(
    {
      error: error instanceof Error ? error.message : "Invalid AI SDK chat request.",
      code: "invalid_request",
    },
    { status: 400 },
  );
