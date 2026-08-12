CREATE TABLE IF NOT EXISTS viby.preview_sessions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  chat_id uuid NOT NULL REFERENCES viby.chats(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES viby.versions(id) ON DELETE CASCADE,
  sandbox_lease_id uuid NOT NULL REFERENCES viby.sandbox_leases(id) ON DELETE CASCADE,
  sandbox_provider text NOT NULL,
  framework text NOT NULL,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  path text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 2000),
  url text,
  status text NOT NULL DEFAULT 'starting'
    CHECK (status IN ('starting', 'ready', 'failed', 'stopped', 'expired')),
  error text,
  expires_at timestamptz NOT NULL,
  ready_at timestamptz,
  stopped_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, user_id, id),
  UNIQUE (tenant_id, user_id, sandbox_lease_id),
  CHECK (status <> 'ready' OR url IS NOT NULL),
  CHECK (status <> 'failed' OR error IS NOT NULL),
  CHECK (status NOT IN ('failed', 'stopped', 'expired') OR stopped_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS preview_sessions_scope_status_idx
  ON viby.preview_sessions (tenant_id, user_id, status, expires_at);

CREATE INDEX IF NOT EXISTS preview_sessions_scope_version_idx
  ON viby.preview_sessions (tenant_id, user_id, version_id, created_at DESC);

CREATE INDEX IF NOT EXISTS preview_sessions_scope_chat_idx
  ON viby.preview_sessions (tenant_id, user_id, chat_id, created_at DESC);
