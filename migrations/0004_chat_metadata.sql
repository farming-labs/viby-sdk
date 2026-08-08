ALTER TABLE viby.chats
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS chats_scope_metadata_idx
  ON viby.chats USING gin (metadata jsonb_path_ops);
