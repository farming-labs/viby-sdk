import type {
  DeletedEnvironmentVariable,
  EnvironmentName,
  EnvironmentVariableStore,
  StoredEnvironmentVariable,
  UpsertEnvironmentVariableRecord,
  UpsertEnvironmentVariableResult,
} from "../../src/environment.js";
import type { UserScope } from "../../src/types.js";

type ScopedVariable = StoredEnvironmentVariable & UserScope;

export class MemoryEnvironmentVariableStore implements EnvironmentVariableStore {
  readonly variables: ScopedVariable[] = [];

  async list(
    scope: UserScope,
    chatId: string,
    environment?: EnvironmentName,
  ): Promise<readonly StoredEnvironmentVariable[]> {
    return this.variables.filter((variable) => (
      variable.tenantId === scope.tenantId
      && variable.userId === scope.userId
      && variable.chatId === chatId
      && (environment === undefined || variable.environment === environment)
    ));
  }

  async upsert(
    scope: UserScope,
    input: UpsertEnvironmentVariableRecord,
  ): Promise<UpsertEnvironmentVariableResult> {
    const index = this.variables.findIndex((variable) => (
      variable.tenantId === scope.tenantId
      && variable.userId === scope.userId
      && variable.chatId === input.chatId
      && variable.environment === input.environment
      && variable.name === input.name
    ));
    const existing = this.variables[index];
    const variable: ScopedVariable = {
      id: existing?.id ?? input.id,
      chatId: input.chatId,
      environment: input.environment,
      name: input.name,
      value: input.value,
      secret: input.secret,
      secretRef: input.secretRef,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
      ...scope,
    };
    if (index >= 0) this.variables[index] = variable;
    else this.variables.push(variable);
    return { variable, replacedSecretRef: existing?.secretRef ?? null };
  }

  async delete(
    scope: UserScope,
    chatId: string,
    environment: EnvironmentName,
    name: string,
  ): Promise<DeletedEnvironmentVariable> {
    const index = this.variables.findIndex((variable) => (
      variable.tenantId === scope.tenantId
      && variable.userId === scope.userId
      && variable.chatId === chatId
      && variable.environment === environment
      && variable.name === name
    ));
    if (index < 0) return { deleted: false, secretRef: null };
    const [deleted] = this.variables.splice(index, 1);
    return { deleted: true, secretRef: deleted?.secretRef ?? null };
  }

  async close(): Promise<void> {}
}
