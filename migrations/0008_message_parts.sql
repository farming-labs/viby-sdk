CREATE TABLE IF NOT EXISTS viby.message_parts (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  message_id uuid NOT NULL REFERENCES viby.messages(id) ON DELETE CASCADE,
  generation_id uuid REFERENCES viby.generations(id) ON DELETE CASCADE,
  attempt_id uuid REFERENCES viby.generation_attempts(id) ON DELETE SET NULL,
  position integer NOT NULL CHECK (position >= 0),
  type text NOT NULL CHECK (type IN (
    'text',
    'status',
    'reasoning-summary',
    'file-read',
    'file-edit',
    'search',
    'command',
    'tool-call',
    'error',
    'usage'
  )),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, position)
);

CREATE INDEX IF NOT EXISTS message_parts_scope_message_idx
  ON viby.message_parts (tenant_id, user_id, message_id, position);

CREATE INDEX IF NOT EXISTS message_parts_scope_generation_idx
  ON viby.message_parts (tenant_id, user_id, generation_id, created_at, id);

INSERT INTO viby.message_parts (
  id, tenant_id, user_id, message_id, generation_id, attempt_id,
  position, type, data, created_at
)
SELECT
  md5(message.id::text || ':text:0')::uuid,
  message.tenant_id,
  message.user_id,
  message.id,
  message.generation_id,
  NULL,
  0,
  'text',
  jsonb_build_object('text', message.content),
  message.created_at
FROM viby.messages AS message
WHERE message.content <> ''
ON CONFLICT (message_id, position) DO NOTHING;
