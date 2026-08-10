CREATE TABLE viby.design_evaluations (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  chat_id uuid NOT NULL REFERENCES viby.chats(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES viby.versions(id) ON DELETE CASCADE,
  generation_id uuid REFERENCES viby.generations(id) ON DELETE SET NULL,
  evaluator text NOT NULL CHECK (char_length(evaluator) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('passed', 'warning', 'failed')),
  score double precision NOT NULL CHECK (score BETWEEN 0 AND 100),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 4000),
  criteria jsonb NOT NULL CHECK (
    jsonb_typeof(criteria) = 'array' AND jsonb_array_length(criteria) BETWEEN 1 AND 50
  ),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, id)
);

CREATE INDEX design_evaluations_scope_version_idx
  ON viby.design_evaluations (tenant_id, user_id, version_id, created_at DESC, id DESC);
