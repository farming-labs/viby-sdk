CREATE TABLE viby.attachments (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  chat_id uuid NOT NULL REFERENCES viby.chats(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES viby.messages(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES viby.generations(id) ON DELETE CASCADE,
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  media_type text NOT NULL CHECK (char_length(media_type) BETWEEN 3 AND 255),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 10000000),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(content) = size),
  UNIQUE (tenant_id, user_id, id)
);

CREATE INDEX attachments_scope_message_idx
  ON viby.attachments (tenant_id, user_id, message_id, created_at, id);

CREATE INDEX attachments_scope_generation_idx
  ON viby.attachments (tenant_id, user_id, generation_id, created_at, id);
