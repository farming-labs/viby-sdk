CREATE TABLE IF NOT EXISTS viby.version_changes (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  version_id uuid NOT NULL REFERENCES viby.versions(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  change jsonb NOT NULL CHECK (
    jsonb_typeof(change) = 'object'
    AND change->>'type' IN ('write', 'delete', 'move')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version_id, position)
);

CREATE INDEX IF NOT EXISTS version_changes_scope_version_idx
  ON viby.version_changes (tenant_id, user_id, version_id, position);
