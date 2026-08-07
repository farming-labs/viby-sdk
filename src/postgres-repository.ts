import postgres from "postgres";
import type {
  ChatData,
  FrameworkId,
  GenerationAttemptData,
  GenerationAttemptReason,
  GenerationAttemptStatus,
  GenerationData,
  GenerationEvent,
  GenerationEventType,
  GenerationStatus,
  GenerationTaskData,
  GenerationTaskRequest,
  GenerationTaskResolution,
  MessageData,
  ResolvedSkill,
  UserScope,
  VersionData,
  VersionFile,
} from "./types.js";
import type {
  AppendGenerationEventRecord,
  CompleteGenerationRecord,
  CreateAttemptRecord,
  CreatedGeneration,
  CreateGenerationRecord,
  ImportedChat,
  ImportChatRecord,
  PauseGenerationRecord,
  Repository,
  ResolveGenerationTaskRecord,
} from "./repository.js";
import { createId } from "./utils.js";
import {
  DatabaseNotReadyError,
  GenerationStateError,
  NotFoundError,
} from "./errors.js";

interface ChatRow {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  framework: string;
  created_at: Date;
  updated_at: Date;
}

interface GenerationRow {
  id: string;
  chat_id: string;
  base_version_id: string | null;
  active_attempt_id: string;
  attempt_count: number;
  prompt: string;
  status: GenerationStatus;
  model_provider: string;
  model_id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

interface GenerationAttemptRow {
  id: string;
  generation_id: string;
  number: number;
  reason: GenerationAttemptReason;
  status: GenerationAttemptStatus;
  model_provider: string;
  model_id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  finish_reason: string | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

interface GenerationEventRow {
  cursor: string | number | bigint;
  generation_id: string;
  attempt_id: string | null;
  type: GenerationEventType;
  data: unknown;
  created_at: Date;
}

interface GenerationTaskRow {
  id: string;
  generation_id: string;
  attempt_id: string;
  status: "pending" | "resolved";
  payload: GenerationTaskRequest;
  resolution: GenerationTaskResolution | null;
  created_at: Date;
  resolved_at: Date | null;
}

interface SkillSnapshotRow {
  name: string;
  description: string;
  category: string;
  source: "skills.sh" | "file";
  locator: string;
  content_hash: string;
  files: ResolvedSkill["files"];
}

interface VersionRow {
  id: string;
  chat_id: string;
  generation_id: string | null;
  parent_version_id: string | null;
  number: number;
  origin: VersionData["origin"];
  framework: string;
  title: string;
  summary: string;
  created_at: Date;
}

interface MessageRow {
  id: string;
  chat_id: string;
  generation_id: string | null;
  role: "user" | "assistant";
  content: string;
  created_at: Date;
}

interface VersionFileRow {
  path: string;
  content: string;
  media_type: string;
  size: number;
  checksum: string;
}

export class PostgresRepository implements Repository {
  readonly #sql: ReturnType<typeof postgres>;
  #ready = false;

  constructor(databaseUrl: string) {
    this.#sql = postgres(databaseUrl, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => undefined,
    });
  }

  async assertReady(): Promise<void> {
    if (this.#ready) return;
    const [row] = await this.#sql<{ ready: boolean }[]>`
      SELECT
        to_regclass('viby.chats') IS NOT NULL
        AND to_regclass('viby.generation_attempts') IS NOT NULL
        AND to_regclass('viby.generation_events') IS NOT NULL
        AND to_regclass('viby.generation_tasks') IS NOT NULL AS ready
    `;
    if (!row?.ready) throw new DatabaseNotReadyError();
    this.#ready = true;
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }

  async createChat<Framework extends FrameworkId>(
    scope: UserScope,
    input: { id: string; title: string; framework: Framework },
  ): Promise<ChatData<Framework>> {
    await this.assertReady();
    const [row] = await this.#sql<ChatRow[]>`
      INSERT INTO viby.chats (id, tenant_id, user_id, title, framework)
      VALUES (${input.id}, ${scope.tenantId}, ${scope.userId}, ${input.title}, ${input.framework})
      RETURNING *
    `;
    if (!row) throw new Error("Postgres did not return the created chat.");
    return mapChat<Framework>(row);
  }

  async importChat<Framework extends FrameworkId>(
    scope: UserScope,
    input: ImportChatRecord<Framework>,
  ): Promise<ImportedChat<Framework>> {
    await this.assertReady();
    const result = await this.#sql.begin(async (sql) => {
      const [chat] = await sql<ChatRow[]>`
        INSERT INTO viby.chats (id, tenant_id, user_id, title, framework)
        VALUES (
          ${input.chatId}, ${scope.tenantId}, ${scope.userId}, ${input.title}, ${input.framework}
        )
        RETURNING *
      `;
      if (!chat) throw new Error("Postgres did not return the imported chat.");

      const [version] = await sql<VersionRow[]>`
        INSERT INTO viby.versions (
          id, tenant_id, user_id, chat_id, generation_id, parent_version_id,
          number, origin, framework, title, summary
        ) VALUES (
          ${input.versionId}, ${scope.tenantId}, ${scope.userId}, ${input.chatId}, NULL, NULL,
          1, 'imported', ${input.framework}, ${input.title}, ${input.summary}
        )
        RETURNING *
      `;
      if (!version) throw new Error("Postgres did not return the imported version.");

      for (const file of input.files) {
        await sql`
          INSERT INTO viby.version_files (
            id, tenant_id, user_id, version_id, path, content, media_type, size, checksum
          ) VALUES (
            ${createId()}, ${scope.tenantId}, ${scope.userId}, ${input.versionId}, ${file.path},
            ${file.content}, ${file.mediaType}, ${file.size}, ${file.checksum}
          )
        `;
      }
      return { chat, version };
    });

    return {
      chat: mapChat<Framework>(result.chat),
      version: mapVersion<Framework>(result.version),
    };
  }

  async getChat<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
  ): Promise<ChatData<Framework> | null> {
    await this.assertReady();
    const [row] = await this.#sql<ChatRow[]>`
      SELECT * FROM viby.chats
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${id}
      LIMIT 1
    `;
    return row ? mapChat<Framework>(row) : null;
  }

  async listChats<Framework extends FrameworkId>(
    scope: UserScope,
    limit: number,
  ): Promise<Array<ChatData<Framework>>> {
    await this.assertReady();
    const rows = await this.#sql<ChatRow[]>`
      SELECT * FROM viby.chats
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map(mapChat<Framework>);
  }

  async createGeneration(
    scope: UserScope,
    input: CreateGenerationRecord,
  ): Promise<CreatedGeneration> {
    await this.assertReady();
    const result = await this.#sql.begin(async (sql) => {
      const [generation] = await sql<GenerationRow[]>`
        INSERT INTO viby.generations (
          id, tenant_id, user_id, chat_id, base_version_id, active_attempt_id,
          attempt_count, prompt, status, model_provider, model_id
        )
        SELECT ${input.id}, ${scope.tenantId}, ${scope.userId}, id, ${input.baseVersionId},
          ${input.attemptId}, 1, ${input.prompt}, 'queued', ${input.modelProvider}, ${input.modelId}
        FROM viby.chats
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${input.chatId}
        RETURNING *
      `;
      if (!generation) throw new NotFoundError("Chat");

      const [attempt] = await sql<GenerationAttemptRow[]>`
        INSERT INTO viby.generation_attempts (
          id, tenant_id, user_id, generation_id, number, reason, status, model_provider, model_id
        ) VALUES (
          ${input.attemptId}, ${scope.tenantId}, ${scope.userId}, ${input.id}, 1,
          'initial', 'queued', ${input.modelProvider}, ${input.modelId}
        )
        RETURNING *
      `;
      if (!attempt) throw new Error("Postgres did not return the created attempt.");

      await sql`
        INSERT INTO viby.messages (
          id, tenant_id, user_id, chat_id, generation_id, role, content
        ) VALUES (
          ${createId()}, ${scope.tenantId}, ${scope.userId}, ${input.chatId}, ${input.id},
          'user', ${input.prompt}
        )
      `;
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${input.id}, ${input.attemptId},
          'generation.created', ${sql.json({ prompt: input.prompt })}
        )
      `;
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${input.id}, ${input.attemptId},
          'attempt.queued', ${sql.json({ number: 1, reason: "initial" })}
        )
      `;
      return { generation, attempt };
    });

    return {
      generation: mapGeneration(result.generation),
      attempt: mapAttempt(result.attempt),
    };
  }

  async startGenerationAttempt(
    scope: UserScope,
    generationId: string,
    attemptId: string,
  ): Promise<GenerationAttemptData> {
    await this.assertReady();
    const row = await this.#sql.begin(async (sql) => {
      const [generation] = await sql<GenerationRow[]>`
        SELECT * FROM viby.generations
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${generationId}
        FOR UPDATE
      `;
      if (!generation) throw new NotFoundError("Generation");
      if (generation.active_attempt_id !== attemptId || generation.status !== "queued") {
        throw new GenerationStateError(
          generationId,
          `Generation ${generationId} cannot start attempt ${attemptId} from ${generation.status}.`,
        );
      }

      const [attempt] = await sql<GenerationAttemptRow[]>`
        UPDATE viby.generation_attempts SET status = 'running', started_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND generation_id = ${generationId} AND id = ${attemptId} AND status = 'queued'
        RETURNING *
      `;
      if (!attempt) {
        throw new GenerationStateError(generationId, `Attempt ${attemptId} is not queued.`);
      }
      await sql`
        UPDATE viby.generations SET
          status = 'running', started_at = COALESCE(started_at, now()),
          completed_at = NULL, error = NULL
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${generationId}
      `;
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${generationId}, ${attemptId},
          'attempt.started', ${sql.json({ number: attempt.number, reason: attempt.reason })}
        )
      `;
      return attempt;
    });
    return mapAttempt(row);
  }

  async createGenerationAttempt(
    scope: UserScope,
    input: CreateAttemptRecord,
  ): Promise<GenerationAttemptData> {
    await this.assertReady();
    const row = await this.#sql.begin(async (sql) => {
      const [generation] = await sql<GenerationRow[]>`
        SELECT * FROM viby.generations
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.generationId}
        FOR UPDATE
      `;
      if (!generation) throw new NotFoundError("Generation");

      const allowed = input.reason === "retry"
        ? generation.status === "failed" || generation.status === "cancelled"
        : generation.status === "failed"
          || generation.status === "cancelled"
          || generation.status === "queued"
          || generation.status === "running";
      if (!allowed) {
        throw new GenerationStateError(
          generation.id,
          `Generation ${generation.id} cannot ${input.reason} from ${generation.status}.`,
        );
      }

      if (generation.status === "queued" || generation.status === "running") {
        const [interrupted] = await sql<GenerationAttemptRow[]>`
          UPDATE viby.generation_attempts SET status = 'interrupted', completed_at = now()
          WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
            AND generation_id = ${generation.id} AND id = ${generation.active_attempt_id}
            AND status IN ('queued', 'running')
          RETURNING *
        `;
        if (interrupted) {
          await sql`
            INSERT INTO viby.generation_events (
              tenant_id, user_id, generation_id, attempt_id, type, data
            ) VALUES (
              ${scope.tenantId}, ${scope.userId}, ${generation.id}, ${interrupted.id},
              'attempt.interrupted', ${sql.json({ number: interrupted.number })}
            )
          `;
        }
      }

      const number = generation.attempt_count + 1;
      const [attempt] = await sql<GenerationAttemptRow[]>`
        INSERT INTO viby.generation_attempts (
          id, tenant_id, user_id, generation_id, number, reason, status, model_provider, model_id
        ) VALUES (
          ${input.id}, ${scope.tenantId}, ${scope.userId}, ${generation.id}, ${number},
          ${input.reason}, 'queued', ${generation.model_provider}, ${generation.model_id}
        )
        RETURNING *
      `;
      if (!attempt) throw new Error("Postgres did not return the created attempt.");

      await sql`
        UPDATE viby.generations SET
          status = 'queued', active_attempt_id = ${input.id}, attempt_count = ${number},
          input_tokens = NULL, output_tokens = NULL, total_tokens = NULL,
          finish_reason = NULL, error = NULL, completed_at = NULL
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${generation.id}
      `;
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${generation.id}, ${input.id},
          'attempt.queued', ${sql.json({ number, reason: input.reason })}
        )
      `;
      return attempt;
    });
    return mapAttempt(row);
  }

  async attachGenerationSkills(
    scope: UserScope,
    generationId: string,
    skills: readonly ResolvedSkill[],
  ): Promise<void> {
    await this.assertReady();
    await this.#sql.begin(async (sql) => {
      const [generation] = await sql<{ id: string }[]>`
        SELECT id FROM viby.generations
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${generationId}
        FOR UPDATE
      `;
      if (!generation) throw new NotFoundError("Generation");

      for (const [position, skill] of skills.entries()) {
        const [snapshot] = await sql<{ id: string }[]>`
          INSERT INTO viby.skill_snapshots (
            id, tenant_id, user_id, source, locator, name, description, content_hash, files
          ) VALUES (
            ${createId()}, ${scope.tenantId}, ${scope.userId}, ${skill.source}, ${skill.locator},
            ${skill.name}, ${skill.description}, ${skill.contentHash},
            ${sql.json(JSON.parse(JSON.stringify(skill.files)))}
          )
          ON CONFLICT (tenant_id, user_id, content_hash)
          DO UPDATE SET locator = EXCLUDED.locator
          RETURNING id
        `;
        if (!snapshot) throw new Error("Postgres did not return the skill snapshot.");
        await sql`
          INSERT INTO viby.generation_skills (
            tenant_id, user_id, generation_id, skill_snapshot_id, category, position, activation
          ) VALUES (
            ${scope.tenantId}, ${scope.userId}, ${generationId}, ${snapshot.id}, ${skill.category},
            ${position}, ${skill.category === "core" ? "always" : "automatic"}
          )
          ON CONFLICT DO NOTHING
        `;
      }
      await sql`
        UPDATE viby.generations SET skills_resolved_at = COALESCE(skills_resolved_at, now())
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${generationId}
      `;
    });
  }

  async getGenerationSkills(
    scope: UserScope,
    generationId: string,
  ): Promise<ResolvedSkill[] | null> {
    await this.assertReady();
    const [generation] = await this.#sql<{ skills_resolved_at: Date | null }[]>`
      SELECT skills_resolved_at FROM viby.generations
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND id = ${generationId}
      LIMIT 1
    `;
    if (!generation) throw new NotFoundError("Generation");
    if (!generation.skills_resolved_at) return null;
    const rows = await this.#sql<SkillSnapshotRow[]>`
      SELECT snapshot.name, snapshot.description, link.category, snapshot.source,
        snapshot.locator, snapshot.content_hash, snapshot.files
      FROM viby.generation_skills AS link
      JOIN viby.skill_snapshots AS snapshot ON snapshot.id = link.skill_snapshot_id
      WHERE link.tenant_id = ${scope.tenantId} AND link.user_id = ${scope.userId}
        AND link.generation_id = ${generationId}
      ORDER BY link.position
    `;
    return rows.map((row) => ({
      name: row.name,
      description: row.description,
      category: row.category,
      source: row.source,
      locator: row.locator,
      contentHash: row.content_hash,
      files: row.files,
    }));
  }

  async appendGenerationEvent<Type extends GenerationEventType>(
    scope: UserScope,
    input: AppendGenerationEventRecord<Type>,
  ): Promise<void> {
    await this.assertReady();
    await this.#sql`
      INSERT INTO viby.generation_events (
        tenant_id, user_id, generation_id, attempt_id, type, data
      )
      SELECT ${scope.tenantId}, ${scope.userId}, id, ${input.attemptId}, ${input.type},
        ${this.#sql.json(JSON.parse(JSON.stringify(input.data)))}
      FROM viby.generations
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND id = ${input.generationId} AND status = 'running'
        AND (${input.attemptId}::uuid IS NULL OR active_attempt_id = ${input.attemptId})
    `;
  }

  async completeGeneration<Framework extends FrameworkId>(
    scope: UserScope,
    input: CompleteGenerationRecord<Framework>,
  ): Promise<VersionData<Framework>> {
    await this.assertReady();
    const row = await this.#sql.begin(async (sql) => {
      const [generation] = await sql<GenerationRow[]>`
        SELECT * FROM viby.generations
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.generationId}
        FOR UPDATE
      `;
      if (!generation) throw new NotFoundError("Generation");
      if (generation.status !== "running" || generation.active_attempt_id !== input.attemptId) {
        throw new GenerationStateError(
          input.generationId,
          `Generation ${input.generationId} cannot complete from ${generation.status}.`,
        );
      }

      const [attempt] = await sql<GenerationAttemptRow[]>`
        SELECT * FROM viby.generation_attempts
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND generation_id = ${input.generationId} AND id = ${input.attemptId}
        FOR UPDATE
      `;
      if (!attempt || attempt.status !== "running") {
        throw new GenerationStateError(input.generationId, `Attempt ${input.attemptId} is not running.`);
      }

      await sql`
        SELECT id FROM viby.chats
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${generation.chat_id}
        FOR UPDATE
      `;
      const [numberRow] = await sql<{ number: number }[]>`
        SELECT COALESCE(MAX(number), 0)::integer + 1 AS number
        FROM viby.versions
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND chat_id = ${generation.chat_id}
      `;
      const versionId = createId();
      const [version] = await sql<VersionRow[]>`
        INSERT INTO viby.versions (
          id, tenant_id, user_id, chat_id, generation_id, parent_version_id,
          number, framework, title, summary
        ) VALUES (
          ${versionId}, ${scope.tenantId}, ${scope.userId}, ${generation.chat_id},
          ${input.generationId}, ${input.parentVersionId}, ${numberRow?.number ?? 1},
          ${input.framework}, ${input.title}, ${input.summary}
        )
        RETURNING *
      `;
      if (!version) throw new Error("Postgres did not return the created version.");

      for (const file of input.files) {
        await sql`
          INSERT INTO viby.version_files (
            id, tenant_id, user_id, version_id, path, content, media_type, size, checksum
          ) VALUES (
            ${createId()}, ${scope.tenantId}, ${scope.userId}, ${versionId}, ${file.path},
            ${file.content}, ${file.mediaType}, ${file.size}, ${file.checksum}
          )
        `;
      }

      await sql`
        INSERT INTO viby.messages (
          id, tenant_id, user_id, chat_id, generation_id, role, content
        ) VALUES (
          ${createId()}, ${scope.tenantId}, ${scope.userId}, ${generation.chat_id},
          ${input.generationId}, 'assistant', ${input.assistantMessage}
        )
      `;
      await sql`
        UPDATE viby.generation_attempts SET
          status = 'succeeded', input_tokens = ${input.inputTokens},
          output_tokens = ${input.outputTokens}, total_tokens = ${input.totalTokens},
          finish_reason = ${input.finishReason}, completed_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${input.attemptId}
      `;
      await sql`
        UPDATE viby.generations SET
          status = 'succeeded', input_tokens = ${input.inputTokens},
          output_tokens = ${input.outputTokens}, total_tokens = ${input.totalTokens},
          finish_reason = ${input.finishReason}, error = NULL, completed_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${input.generationId}
      `;
      await sql`
        UPDATE viby.chats SET title = ${input.title}, updated_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${generation.chat_id}
      `;
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${input.generationId}, ${input.attemptId},
          'attempt.succeeded', ${sql.json({ number: attempt.number, versionId })}
        )
      `;
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${input.generationId}, ${input.attemptId},
          'generation.succeeded', ${sql.json({ versionId })}
        )
      `;
      return version;
    });
    return mapVersion<Framework>(row);
  }

  async pauseGeneration(
    scope: UserScope,
    input: PauseGenerationRecord,
  ): Promise<GenerationTaskData> {
    await this.assertReady();
    const row = await this.#sql.begin(async (sql) => {
      const [generation] = await sql<GenerationRow[]>`
        SELECT * FROM viby.generations
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.generationId}
        FOR UPDATE
      `;
      if (!generation) throw new NotFoundError("Generation");
      if (generation.status !== "running" || generation.active_attempt_id !== input.attemptId) {
        throw new GenerationStateError(
          generation.id,
          `Generation ${generation.id} cannot wait for a task from ${generation.status}.`,
        );
      }
      const [attempt] = await sql<GenerationAttemptRow[]>`
        SELECT * FROM viby.generation_attempts
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.attemptId} AND generation_id = ${input.generationId}
        FOR UPDATE
      `;
      if (!attempt || attempt.status !== "running") {
        throw new GenerationStateError(generation.id, `Attempt ${input.attemptId} is not running.`);
      }

      const [task] = await sql<GenerationTaskRow[]>`
        INSERT INTO viby.generation_tasks (
          id, tenant_id, user_id, generation_id, attempt_id, kind, title, message, payload
        ) VALUES (
          ${input.taskId}, ${scope.tenantId}, ${scope.userId}, ${input.generationId},
          ${input.attemptId}, ${input.task.kind}, ${input.task.title}, ${input.task.message},
          ${sql.json(JSON.parse(JSON.stringify(input.task)))}
        )
        RETURNING id, generation_id, attempt_id, status, payload, resolution, created_at, resolved_at
      `;
      if (!task) throw new Error("Postgres did not return the created task.");

      await sql`
        INSERT INTO viby.messages (
          id, tenant_id, user_id, chat_id, generation_id, role, content
        ) VALUES (
          ${createId()}, ${scope.tenantId}, ${scope.userId}, ${generation.chat_id},
          ${input.generationId}, 'assistant', ${input.task.message}
        )
      `;
      await sql`
        UPDATE viby.generation_attempts SET
          status = 'waiting', input_tokens = ${input.inputTokens},
          output_tokens = ${input.outputTokens}, total_tokens = ${input.totalTokens},
          finish_reason = ${input.finishReason}, completed_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${input.attemptId}
      `;
      await sql`
        UPDATE viby.generations SET
          status = 'waiting', input_tokens = ${input.inputTokens},
          output_tokens = ${input.outputTokens}, total_tokens = ${input.totalTokens},
          finish_reason = ${input.finishReason}, error = NULL
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${input.generationId}
      `;
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${input.generationId}, ${input.attemptId},
          'attempt.waiting', ${sql.json({ taskId: input.taskId })}
        )
      `;
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${input.generationId}, ${input.attemptId},
          'task.created', ${sql.json({ task: { id: input.taskId, ...input.task } })}
        )
      `;
      return task;
    });
    return mapTask(row);
  }

  async resolveGenerationTask(
    scope: UserScope,
    input: ResolveGenerationTaskRecord,
  ): Promise<GenerationAttemptData> {
    await this.assertReady();
    const row = await this.#sql.begin(async (sql) => {
      const [generation] = await sql<GenerationRow[]>`
        SELECT * FROM viby.generations
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.generationId}
        FOR UPDATE
      `;
      if (!generation) throw new NotFoundError("Generation");
      if (generation.status !== "waiting") {
        throw new GenerationStateError(
          generation.id,
          `Generation ${generation.id} cannot resolve a task from ${generation.status}.`,
        );
      }

      const [task] = await sql<GenerationTaskRow[]>`
        SELECT id, generation_id, attempt_id, status, payload, resolution, created_at, resolved_at
        FROM viby.generation_tasks
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND generation_id = ${input.generationId} AND id = ${input.taskId}
        FOR UPDATE
      `;
      if (!task) throw new NotFoundError("Generation task");
      if (task.status !== "pending") {
        throw new GenerationStateError(generation.id, `Task ${input.taskId} is already resolved.`);
      }

      await sql`
        UPDATE viby.generation_tasks SET
          status = 'resolved', resolution = ${sql.json(JSON.parse(JSON.stringify(input.resolution)))},
          resolved_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${input.taskId}
      `;
      await sql`
        INSERT INTO viby.messages (
          id, tenant_id, user_id, chat_id, generation_id, role, content
        ) VALUES (
          ${createId()}, ${scope.tenantId}, ${scope.userId}, ${generation.chat_id},
          ${input.generationId}, 'user', ${input.resolutionMessage}
        )
      `;

      const number = generation.attempt_count + 1;
      const [attempt] = await sql<GenerationAttemptRow[]>`
        INSERT INTO viby.generation_attempts (
          id, tenant_id, user_id, generation_id, number, reason, status, model_provider, model_id
        ) VALUES (
          ${input.attemptId}, ${scope.tenantId}, ${scope.userId}, ${generation.id}, ${number},
          'task_resolution', 'queued', ${generation.model_provider}, ${generation.model_id}
        )
        RETURNING *
      `;
      if (!attempt) throw new Error("Postgres did not return the created attempt.");

      await sql`
        UPDATE viby.generations SET
          status = 'queued', active_attempt_id = ${input.attemptId}, attempt_count = ${number},
          input_tokens = NULL, output_tokens = NULL, total_tokens = NULL,
          finish_reason = NULL, error = NULL, completed_at = NULL
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${generation.id}
      `;
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${generation.id}, ${task.attempt_id},
          'task.resolved', ${sql.json(JSON.parse(JSON.stringify({
            taskId: input.taskId,
            resolution: input.resolution,
          })))}
        )
      `;
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${generation.id}, ${input.attemptId},
          'attempt.queued', ${sql.json({ number, reason: "task_resolution" })}
        )
      `;
      return attempt;
    });
    return mapAttempt(row);
  }

  async failGenerationAttempt(
    scope: UserScope,
    generationId: string,
    attemptId: string,
    error: string,
  ): Promise<void> {
    await this.assertReady();
    const message = error.slice(0, 10_000);
    await this.#sql.begin(async (sql) => {
      const [generation] = await sql<GenerationRow[]>`
        SELECT * FROM viby.generations
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${generationId}
        FOR UPDATE
      `;
      if (!generation) throw new NotFoundError("Generation");
      if (generation.active_attempt_id !== attemptId || generation.status !== "running") return;

      const [attempt] = await sql<GenerationAttemptRow[]>`
        UPDATE viby.generation_attempts SET
          status = 'failed', error = ${message}, completed_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND generation_id = ${generationId} AND id = ${attemptId} AND status = 'running'
        RETURNING *
      `;
      if (!attempt) return;
      await sql`
        UPDATE viby.generations SET status = 'failed', error = ${message}, completed_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${generationId}
      `;
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${generationId}, ${attemptId},
          'attempt.failed', ${sql.json({ number: attempt.number, error: message })}
        )
      `;
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${generationId}, ${attemptId},
          'generation.failed', ${sql.json({ error: message })}
        )
      `;
    });
  }

  async cancelGeneration(scope: UserScope, generationId: string, reason: string): Promise<boolean> {
    await this.assertReady();
    return this.#sql.begin(async (sql) => {
      const [generation] = await sql<GenerationRow[]>`
        SELECT * FROM viby.generations
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${generationId}
        FOR UPDATE
      `;
      if (!generation) throw new NotFoundError("Generation");
      if (generation.status === "succeeded" || generation.status === "failed" || generation.status === "cancelled") {
        return false;
      }

      const message = reason.slice(0, 2_000);
      const [attempt] = await sql<GenerationAttemptRow[]>`
        UPDATE viby.generation_attempts SET
          status = 'cancelled', error = ${message}, completed_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND generation_id = ${generationId} AND id = ${generation.active_attempt_id}
          AND status IN ('queued', 'running', 'waiting')
        RETURNING *
      `;
      await sql`
        UPDATE viby.generations SET status = 'cancelled', error = ${message}, completed_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${generationId}
      `;
      if (attempt) {
        await sql`
          INSERT INTO viby.generation_events (
            tenant_id, user_id, generation_id, attempt_id, type, data
          ) VALUES (
            ${scope.tenantId}, ${scope.userId}, ${generationId}, ${attempt.id},
            'attempt.cancelled', ${sql.json({ number: attempt.number, reason: message })}
          )
        `;
      }
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${generationId}, ${generation.active_attempt_id},
          'generation.cancelled', ${sql.json({ reason: message })}
        )
      `;
      return true;
    });
  }

  async getGeneration(scope: UserScope, id: string): Promise<GenerationData | null> {
    await this.assertReady();
    const [row] = await this.#sql<GenerationRow[]>`
      SELECT * FROM viby.generations
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${id}
      LIMIT 1
    `;
    return row ? mapGeneration(row) : null;
  }

  async listGenerationAttempts(
    scope: UserScope,
    generationId: string,
  ): Promise<GenerationAttemptData[]> {
    await this.assertReady();
    const rows = await this.#sql<GenerationAttemptRow[]>`
      SELECT attempt.* FROM viby.generation_attempts AS attempt
      JOIN viby.generations AS generation ON generation.id = attempt.generation_id
      WHERE attempt.tenant_id = ${scope.tenantId} AND attempt.user_id = ${scope.userId}
        AND attempt.generation_id = ${generationId}
        AND generation.tenant_id = ${scope.tenantId} AND generation.user_id = ${scope.userId}
      ORDER BY attempt.number
    `;
    return rows.map(mapAttempt);
  }

  async listGenerationEvents(
    scope: UserScope,
    generationId: string,
    after: string,
    limit: number,
  ): Promise<GenerationEvent[]> {
    await this.assertReady();
    const rows = await this.#sql<GenerationEventRow[]>`
      SELECT event.cursor, event.generation_id, event.attempt_id, event.type, event.data,
        event.created_at
      FROM viby.generation_events AS event
      JOIN viby.generations AS generation ON generation.id = event.generation_id
      WHERE event.tenant_id = ${scope.tenantId} AND event.user_id = ${scope.userId}
        AND event.generation_id = ${generationId} AND event.cursor > ${after}
        AND generation.tenant_id = ${scope.tenantId} AND generation.user_id = ${scope.userId}
      ORDER BY event.cursor
      LIMIT ${limit}
    `;
    return rows.map(mapEvent);
  }

  async listGenerationTasks(
    scope: UserScope,
    generationId: string,
  ): Promise<GenerationTaskData[]> {
    await this.assertReady();
    const rows = await this.#sql<GenerationTaskRow[]>`
      SELECT task.id, task.generation_id, task.attempt_id, task.status, task.payload,
        task.resolution, task.created_at, task.resolved_at
      FROM viby.generation_tasks AS task
      JOIN viby.generations AS generation ON generation.id = task.generation_id
      WHERE task.tenant_id = ${scope.tenantId} AND task.user_id = ${scope.userId}
        AND task.generation_id = ${generationId}
        AND generation.tenant_id = ${scope.tenantId} AND generation.user_id = ${scope.userId}
      ORDER BY task.created_at, task.id
    `;
    return rows.map(mapTask);
  }

  async getVersionByGeneration<Framework extends FrameworkId>(
    scope: UserScope,
    generationId: string,
  ): Promise<VersionData<Framework> | null> {
    await this.assertReady();
    const [row] = await this.#sql<VersionRow[]>`
      SELECT * FROM viby.versions
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND generation_id = ${generationId}
      LIMIT 1
    `;
    return row ? mapVersion<Framework>(row) : null;
  }

  async getVersion<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
  ): Promise<VersionData<Framework> | null> {
    await this.assertReady();
    const [row] = await this.#sql<VersionRow[]>`
      SELECT * FROM viby.versions
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${id}
      LIMIT 1
    `;
    return row ? mapVersion<Framework>(row) : null;
  }

  async getLatestVersion<Framework extends FrameworkId>(
    scope: UserScope,
    chatId: string,
  ): Promise<VersionData<Framework> | null> {
    await this.assertReady();
    const [row] = await this.#sql<VersionRow[]>`
      SELECT * FROM viby.versions
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND chat_id = ${chatId}
      ORDER BY number DESC
      LIMIT 1
    `;
    return row ? mapVersion<Framework>(row) : null;
  }

  async listVersions<Framework extends FrameworkId>(
    scope: UserScope,
    chatId: string,
  ): Promise<Array<VersionData<Framework>>> {
    await this.assertReady();
    const rows = await this.#sql<VersionRow[]>`
      SELECT * FROM viby.versions
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND chat_id = ${chatId}
      ORDER BY number DESC
    `;
    return rows.map(mapVersion<Framework>);
  }

  async listMessages(scope: UserScope, chatId: string): Promise<MessageData[]> {
    await this.assertReady();
    const rows = await this.#sql<MessageRow[]>`
      SELECT id, chat_id, generation_id, role, content, created_at
      FROM viby.messages
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND chat_id = ${chatId}
      ORDER BY created_at, id
    `;
    return rows.map(mapMessage);
  }

  async getVersionFiles(scope: UserScope, versionId: string): Promise<VersionFile[]> {
    await this.assertReady();
    const rows = await this.#sql<VersionFileRow[]>`
      SELECT path, content, media_type, size, checksum
      FROM viby.version_files
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND version_id = ${versionId}
      ORDER BY path
    `;
    return rows.map((row) => ({
      path: row.path,
      content: row.content,
      mediaType: row.media_type,
      size: row.size,
      checksum: row.checksum,
    }));
  }
}

function mapChat<Framework extends FrameworkId>(row: ChatRow): ChatData<Framework> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    title: row.title,
    framework: row.framework as Framework,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapGeneration(row: GenerationRow): GenerationData {
  return {
    id: row.id,
    chatId: row.chat_id,
    baseVersionId: row.base_version_id,
    activeAttemptId: row.active_attempt_id,
    attemptCount: row.attempt_count,
    prompt: row.prompt,
    status: row.status,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapAttempt(row: GenerationAttemptRow): GenerationAttemptData {
  return {
    id: row.id,
    generationId: row.generation_id,
    number: row.number,
    reason: row.reason,
    status: row.status,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    finishReason: row.finish_reason,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapEvent(row: GenerationEventRow): GenerationEvent {
  return {
    cursor: String(row.cursor),
    generationId: row.generation_id,
    attemptId: row.attempt_id,
    type: row.type,
    data: row.data,
    createdAt: row.created_at,
  } as GenerationEvent;
}

function mapTask(row: GenerationTaskRow): GenerationTaskData {
  return {
    ...row.payload,
    id: row.id,
    generationId: row.generation_id,
    attemptId: row.attempt_id,
    status: row.status,
    resolution: row.resolution,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  } as GenerationTaskData;
}

function mapVersion<Framework extends FrameworkId>(row: VersionRow): VersionData<Framework> {
  return {
    id: row.id,
    chatId: row.chat_id,
    generationId: row.generation_id,
    parentVersionId: row.parent_version_id,
    number: row.number,
    origin: row.origin,
    framework: row.framework as Framework,
    title: row.title,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

function mapMessage(row: MessageRow): MessageData {
  return {
    id: row.id,
    chatId: row.chat_id,
    generationId: row.generation_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}
