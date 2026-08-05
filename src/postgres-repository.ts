import postgres from "postgres";
import type {
  ChatData,
  FrameworkId,
  GenerationData,
  MessageData,
  UserScope,
  VersionData,
  VersionFile,
} from "./types.js";
import type {
  CompleteGenerationRecord,
  CreateGenerationRecord,
  Repository,
} from "./repository.js";
import { createId } from "./utils.js";
import { DatabaseNotReadyError, NotFoundError } from "./errors.js";

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
  status: "pending" | "succeeded" | "failed";
  model_provider: string;
  model_id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  error: string | null;
  created_at: Date;
  completed_at: Date | null;
}

interface VersionRow {
  id: string;
  chat_id: string;
  generation_id: string;
  parent_version_id: string | null;
  number: number;
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
      SELECT to_regclass('viby.chats') IS NOT NULL AS ready
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

  async createGeneration(scope: UserScope, input: CreateGenerationRecord): Promise<GenerationData> {
    await this.assertReady();
    const row = await this.#sql.begin(async (sql) => {
      const [generation] = await sql<GenerationRow[]>`
        INSERT INTO viby.generations (
          id, tenant_id, user_id, chat_id, base_version_id, status, model_provider, model_id
        )
        SELECT ${input.id}, ${scope.tenantId}, ${scope.userId}, id, ${input.baseVersionId},
          'pending', ${input.modelProvider}, ${input.modelId}
        FROM viby.chats
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${input.chatId}
        RETURNING *
      `;
      if (!generation) throw new NotFoundError("Chat");

      await sql`
        INSERT INTO viby.messages (
          id, tenant_id, user_id, chat_id, generation_id, role, content
        ) VALUES (
          ${createId()}, ${scope.tenantId}, ${scope.userId}, ${input.chatId}, ${input.id}, 'user', ${input.prompt}
        )
      `;

      for (const [position, skill] of input.skills.entries()) {
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
            ${scope.tenantId}, ${scope.userId}, ${input.id}, ${snapshot.id}, ${skill.category},
            ${position}, ${skill.category === "core" ? "always" : "automatic"}
          )
          ON CONFLICT DO NOTHING
        `;
      }
      return generation;
    });
    return mapGeneration(row);
  }

  async completeGeneration<Framework extends FrameworkId>(
    scope: UserScope,
    input: CompleteGenerationRecord<Framework>,
  ): Promise<VersionData<Framework>> {
    await this.assertReady();
    const row = await this.#sql.begin(async (sql) => {
      const [generation] = await sql<{ chat_id: string; status: string }[]>`
        SELECT chat_id, status FROM viby.generations
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${input.generationId}
        FOR UPDATE
      `;
      if (!generation) throw new NotFoundError("Generation");
      if (generation.status !== "pending") {
        throw new Error(`Generation ${input.generationId} is already ${generation.status}.`);
      }

      await sql`
        SELECT id FROM viby.chats
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${generation.chat_id}
        FOR UPDATE
      `;
      const [numberRow] = await sql<{ number: number }[]>`
        SELECT COALESCE(MAX(number), 0)::integer + 1 AS number
        FROM viby.versions
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND chat_id = ${generation.chat_id}
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
        UPDATE viby.generations SET
          status = 'succeeded', input_tokens = ${input.inputTokens},
          output_tokens = ${input.outputTokens}, total_tokens = ${input.totalTokens},
          finish_reason = ${input.finishReason}, completed_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${input.generationId}
      `;
      await sql`
        UPDATE viby.chats SET title = ${input.title}, updated_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${generation.chat_id}
      `;
      return version;
    });
    return mapVersion<Framework>(row);
  }

  async failGeneration(scope: UserScope, generationId: string, error: string): Promise<void> {
    await this.assertReady();
    await this.#sql`
      UPDATE viby.generations SET status = 'failed', error = ${error.slice(0, 10_000)}, completed_at = now()
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND id = ${generationId} AND status = 'pending'
    `;
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
    status: row.status,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function mapVersion<Framework extends FrameworkId>(row: VersionRow): VersionData<Framework> {
  return {
    id: row.id,
    chatId: row.chat_id,
    generationId: row.generation_id,
    parentVersionId: row.parent_version_id,
    number: row.number,
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
