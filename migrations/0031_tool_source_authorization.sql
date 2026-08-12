CREATE TABLE IF NOT EXISTS viby.tool_source_authorization_sessions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  tool_source_id uuid NOT NULL,
  provider text NOT NULL,
  state_hash text NOT NULL UNIQUE,
  callback_url text NOT NULL,
  return_to text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  session_secret_ref text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, user_id, tool_source_id)
    REFERENCES viby.tool_sources(tenant_id, user_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS viby.tool_source_connections (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  tool_source_id uuid NOT NULL,
  provider text NOT NULL,
  external_account_id text NOT NULL,
  external_account_name text NOT NULL,
  external_account_url text,
  external_account_metadata jsonb,
  secret_ref text,
  status text NOT NULL
    CHECK (status IN ('active', 'authorization-required', 'permission-upgrade-required', 'revoked')),
  scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, user_id, tool_source_id),
  FOREIGN KEY (tenant_id, user_id, tool_source_id)
    REFERENCES viby.tool_sources(tenant_id, user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tool_source_authorization_sessions_expiry_idx
  ON viby.tool_source_authorization_sessions (expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS tool_source_connections_scope_status_idx
  ON viby.tool_source_connections (tenant_id, user_id, status, updated_at DESC);
