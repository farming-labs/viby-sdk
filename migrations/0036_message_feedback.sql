CREATE TABLE IF NOT EXISTS viby.message_feedback (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  chat_id uuid NOT NULL REFERENCES viby.chats(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES viby.messages(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES viby.generations(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES viby.generation_attempts(id) ON DELETE CASCADE,
  version_id uuid REFERENCES viby.versions(id) ON DELETE SET NULL,
  model_provider text NOT NULL,
  model_id text NOT NULL,
  rating text NOT NULL CHECK (rating IN ('positive', 'negative')),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  comment text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, id),
  UNIQUE (tenant_id, user_id, message_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS message_feedback_scope_message_idx
  ON viby.message_feedback (tenant_id, user_id, chat_id, message_id, created_at, id);
