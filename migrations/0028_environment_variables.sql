ALTER TABLE viby.integration_secrets
  DROP CONSTRAINT IF EXISTS integration_secrets_purpose_check;

ALTER TABLE viby.integration_secrets
  ADD CONSTRAINT integration_secrets_purpose_check
  CHECK (purpose IN ('authorization-session', 'integration-credential', 'environment-variable'));

CREATE TABLE viby.environment_variables (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  chat_id uuid NOT NULL REFERENCES viby.chats(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (
    environment ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'
  ),
  name text NOT NULL CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  plain_value text,
  secret boolean NOT NULL,
  secret_ref text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (
    (secret AND plain_value IS NULL AND secret_ref IS NOT NULL)
    OR (NOT secret AND plain_value IS NOT NULL AND secret_ref IS NULL)
  ),
  UNIQUE (tenant_id, user_id, id),
  UNIQUE (tenant_id, user_id, chat_id, environment, name)
);

CREATE INDEX environment_variables_scope_chat_idx
  ON viby.environment_variables (tenant_id, user_id, chat_id, environment, name);
