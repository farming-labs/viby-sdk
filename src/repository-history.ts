import type {
  RepositoryCommitData,
  RepositoryData,
  RepositoryPullRequestData,
  RepositoryReference,
  RepositoryVisibility,
} from "./integrations.js";

export type RepositoryPushStatus = "pending" | "pushed" | "conflict" | "failed";

export interface RepositoryLinkData {
  readonly id: string;
  readonly chatId: string;
  readonly integrationId: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly repositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly visibility: RepositoryVisibility;
  readonly url: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RepositoryPushData {
  readonly id: string;
  readonly chatId: string;
  readonly versionId: string;
  readonly repositoryLinkId: string | null;
  readonly integrationId: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly target: RepositoryReference;
  readonly branch: string;
  readonly commitMessage: string;
  readonly expectedHead: string | null;
  readonly status: RepositoryPushStatus;
  readonly commit: RepositoryCommitData | null;
  readonly changedFiles: number | null;
  readonly pullRequest: RepositoryPullRequestData | null;
  readonly actualHead: string | null;
  readonly error: string | null;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

export interface BeginRepositoryPushRecord {
  readonly id: string;
  readonly chatId: string;
  readonly versionId: string;
  readonly integrationId: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly target: RepositoryReference;
  readonly branch: string;
  readonly commitMessage: string;
  readonly expectedHead: string | null;
  readonly idempotencyKey: string;
  readonly now: Date;
}

export interface CompleteRepositoryPushRecord {
  readonly id: string;
  readonly repository: RepositoryData;
  readonly result:
    | {
        readonly status: "pushed";
        readonly commit: RepositoryCommitData;
        readonly changedFiles: number;
        readonly pullRequest: RepositoryPullRequestData | null;
      }
    | {
        readonly status: "conflict";
        readonly actualHead: string;
      };
  readonly completedAt: Date;
}

export interface FailRepositoryPushRecord {
  readonly id: string;
  readonly error: string;
  readonly completedAt: Date;
}
