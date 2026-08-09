ALTER TABLE viby.chats
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS purge_after timestamptz;

ALTER TABLE viby.chats
  DROP CONSTRAINT IF EXISTS chats_purge_requires_deletion;

ALTER TABLE viby.chats
  ADD CONSTRAINT chats_purge_requires_deletion
  CHECK (purge_after IS NULL OR deleted_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS chats_scope_purge_idx
  ON viby.chats (tenant_id, user_id, purge_after, id)
  WHERE deleted_at IS NOT NULL AND purge_after IS NOT NULL;
