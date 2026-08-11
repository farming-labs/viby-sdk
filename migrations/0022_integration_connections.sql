CREATE TABLE viby.integration_authorization_sessions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  category text NOT NULL CHECK (category IN ('repository', 'deployment')),
  integration_id text NOT NULL CHECK (
    integration_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'
  ),
  provider text NOT NULL CHECK (
    provider ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'
  ),
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  callback_url text NOT NULL CHECK (char_length(callback_url) BETWEEN 8 AND 2000),
  return_to text NOT NULL CHECK (char_length(return_to) BETWEEN 1 AND 2000),
  scopes text[] NOT NULL DEFAULT '{}',
  session_secret_ref text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, user_id, id)
);

CREATE INDEX integration_authorization_sessions_scope_idx
  ON viby.integration_authorization_sessions (
    tenant_id, user_id, category, integration_id, created_at DESC
  );

CREATE TABLE viby.integration_connections (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  category text NOT NULL CHECK (category IN ('repository', 'deployment')),
  integration_id text NOT NULL CHECK (
    integration_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'
  ),
  provider text NOT NULL CHECK (
    provider ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'
  ),
  external_account_id text NOT NULL CHECK (char_length(external_account_id) BETWEEN 1 AND 500),
  external_account_name text NOT NULL CHECK (char_length(external_account_name) BETWEEN 1 AND 500),
  external_account_url text,
  external_account_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_ref text,
  status text NOT NULL CHECK (
    status IN ('active', 'authorization-required', 'permission-upgrade-required', 'revoked')
  ),
  scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (
    tenant_id, user_id, category, integration_id, external_account_id
  ),
  UNIQUE (tenant_id, user_id, id)
);

CREATE INDEX integration_connections_scope_idx
  ON viby.integration_connections (
    tenant_id, user_id, category, integration_id, status, updated_at DESC
  );

CREATE TABLE viby.integration_secrets (
  reference uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('authorization-session', 'integration-credential')),
  ciphertext bytea NOT NULL,
  initialization_vector bytea NOT NULL CHECK (octet_length(initialization_vector) = 12),
  authentication_tag bytea NOT NULL CHECK (octet_length(authentication_tag) = 16),
  expires_at timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, user_id, reference)
);

CREATE INDEX integration_secrets_scope_idx
  ON viby.integration_secrets (tenant_id, user_id, created_at DESC);
