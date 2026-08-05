import type { LanguageModel } from "ai";

export type FrameworkId =
  | "farm"
  | "tanstack-start"
  | "next"
  | (string & {});

export type BuiltInSkillCategory =
  | "core"
  | "product"
  | "design"
  | "frontend"
  | "backend"
  | "data"
  | "ai"
  | "testing"
  | "security"
  | "accessibility"
  | "performance"
  | "delivery";

export type SkillCategory = BuiltInSkillCategory | (string & {});

export type SkillsShSkillId = `${string}/${string}/${string}`;

export interface LocalSkillReference {
  readonly source: "file";
  readonly path: string;
}

export type SkillReference = SkillsShSkillId | LocalSkillReference;

export type SkillGroups = {
  readonly [category: string]: readonly SkillReference[] | undefined;
} & {
  readonly [Category in BuiltInSkillCategory]?: readonly SkillReference[];
};

export interface VibyConfig<Framework extends FrameworkId = FrameworkId> {
  readonly framework: Framework;
  readonly model: LanguageModel;
  readonly skills?: SkillGroups;
}

export interface UserScope {
  readonly tenantId: string;
  readonly userId: string;
}

export interface CreateChatInput {
  readonly title?: string;
}

export interface GenerateInput {
  readonly prompt: string;
}

export type IterateInput = GenerateInput;

export interface ChatData<Framework extends FrameworkId = FrameworkId> {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly title: string;
  readonly framework: Framework;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MessageData {
  readonly id: string;
  readonly chatId: string;
  readonly generationId: string | null;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt: Date;
}

export interface GenerationData {
  readonly id: string;
  readonly chatId: string;
  readonly status: "pending" | "succeeded" | "failed";
  readonly modelProvider: string;
  readonly modelId: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface VersionData<Framework extends FrameworkId = FrameworkId> {
  readonly id: string;
  readonly chatId: string;
  readonly generationId: string;
  readonly parentVersionId: string | null;
  readonly number: number;
  readonly framework: Framework;
  readonly title: string;
  readonly summary: string;
  readonly createdAt: Date;
}

export interface VersionFile {
  readonly path: string;
  readonly content: string;
  readonly mediaType: string;
  readonly size: number;
  readonly checksum: string;
}

export interface SkillFile {
  readonly path: string;
  readonly content: string;
}

export interface ResolvedSkill {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly source: "skills.sh" | "file";
  readonly locator: string;
  readonly contentHash: string;
  readonly files: readonly SkillFile[];
}
