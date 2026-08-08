CREATE TABLE IF NOT EXISTS viby.tool_calls (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  generation_id uuid NOT NULL REFERENCES viby.generations(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES viby.generation_attempts(id) ON DELETE CASCADE,
  message_id uuid REFERENCES viby.messages(id) ON DELETE SET NULL,
  provider_call_id text NOT NULL CHECK (char_length(provider_call_id) BETWEEN 1 AND 500),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  effect text NOT NULL CHECK (effect IN ('read', 'write', 'external')),
  arguments jsonb NOT NULL,
  result jsonb,
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  error text,
  idempotency_key text CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (effect <> 'external' OR idempotency_key IS NOT NULL),
  UNIQUE (tenant_id, user_id, generation_id, attempt_id, provider_call_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS tool_calls_external_idempotency_idx
  ON viby.tool_calls (tenant_id, user_id, name, idempotency_key)
  WHERE effect = 'external';

CREATE INDEX IF NOT EXISTS tool_calls_scope_generation_idx
  ON viby.tool_calls (tenant_id, user_id, generation_id, created_at, id);

CREATE INDEX IF NOT EXISTS tool_calls_scope_attempt_idx
  ON viby.tool_calls (tenant_id, user_id, attempt_id, created_at, id);
