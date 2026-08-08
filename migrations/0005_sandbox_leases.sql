CREATE TABLE IF NOT EXISTS viby.sandbox_leases (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  chat_id uuid NOT NULL REFERENCES viby.chats(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES viby.versions(id) ON DELETE CASCADE,
  framework text NOT NULL,
  provider text NOT NULL,
  sandbox_id text NOT NULL,
  ports integer[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'stopped', 'expired')),
  expires_at timestamptz NOT NULL,
  stopped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, id),
  CHECK (cardinality(ports) <= 16)
);

CREATE INDEX IF NOT EXISTS sandbox_leases_scope_status_idx
  ON viby.sandbox_leases (tenant_id, user_id, status, expires_at);

CREATE INDEX IF NOT EXISTS sandbox_leases_scope_version_idx
  ON viby.sandbox_leases (tenant_id, user_id, version_id, created_at DESC);
