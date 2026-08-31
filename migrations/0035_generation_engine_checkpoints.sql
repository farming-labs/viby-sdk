CREATE TABLE IF NOT EXISTS viby.generation_engine_checkpoints (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  generation_id uuid NOT NULL REFERENCES viby.generations(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES viby.generation_attempts(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  cursor text,
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, generation_id, attempt_id)
);

CREATE INDEX IF NOT EXISTS generation_engine_checkpoints_scope_attempt_idx
  ON viby.generation_engine_checkpoints (tenant_id, user_id, attempt_id);
