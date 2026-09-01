CREATE TABLE IF NOT EXISTS viby.provider_request_attribution (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  chat_id uuid NOT NULL REFERENCES viby.chats(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES viby.generations(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES viby.generation_attempts(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 0),
  idempotency_key text NOT NULL,
  provider_request_id text,
  model_provider text NOT NULL,
  model_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  total_tokens bigint CHECK (total_tokens IS NULL OR total_tokens >= 0),
  cache_read_tokens bigint CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_write_tokens bigint CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  latency_ms bigint CHECK (latency_ms IS NULL OR latency_ms >= 0),
  estimated_cost_micros bigint CHECK (estimated_cost_micros IS NULL OR estimated_cost_micros >= 0),
  cost_currency text,
  model_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, attempt_id, idempotency_key),
  UNIQUE (tenant_id, user_id, attempt_id, sequence),
  CHECK ((estimated_cost_micros IS NULL) = (cost_currency IS NULL))
);

CREATE INDEX IF NOT EXISTS provider_request_attribution_generation_idx
  ON viby.provider_request_attribution (
    tenant_id, user_id, generation_id, attempt_id, sequence
  );

CREATE INDEX IF NOT EXISTS provider_request_attribution_provider_id_idx
  ON viby.provider_request_attribution (model_provider, provider_request_id)
  WHERE provider_request_id IS NOT NULL;
