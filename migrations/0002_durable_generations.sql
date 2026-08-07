ALTER TABLE viby.generations
  ADD COLUMN IF NOT EXISTS prompt text,
  ADD COLUMN IF NOT EXISTS active_attempt_id uuid,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS skills_resolved_at timestamptz;

UPDATE viby.generations
SET skills_resolved_at = created_at
WHERE skills_resolved_at IS NULL;

UPDATE viby.generations AS generation
SET prompt = COALESCE(
  (
    SELECT message.content
    FROM viby.messages AS message
    WHERE message.tenant_id = generation.tenant_id
      AND message.user_id = generation.user_id
      AND message.generation_id = generation.id
      AND message.role = 'user'
    ORDER BY message.created_at, message.id
    LIMIT 1
  ),
  'Imported generation'
)
WHERE prompt IS NULL;

ALTER TABLE viby.generations
  ALTER COLUMN prompt SET NOT NULL;

ALTER TABLE viby.generations
  DROP CONSTRAINT IF EXISTS generations_status_check;

UPDATE viby.generations
SET status = 'failed',
    error = COALESCE(error, 'Generation was interrupted before durable attempts were enabled.'),
    completed_at = COALESCE(completed_at, now())
WHERE status = 'pending';

ALTER TABLE viby.generations
  ADD CONSTRAINT generations_status_check
  CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'));

CREATE TABLE IF NOT EXISTS viby.generation_attempts (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  generation_id uuid NOT NULL REFERENCES viby.generations(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  reason text NOT NULL CHECK (reason IN ('initial', 'retry', 'resume', 'task_resolution')),
  status text NOT NULL CHECK (
    status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted')
  ),
  model_provider text NOT NULL,
  model_id text NOT NULL,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  finish_reason text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (tenant_id, user_id, id),
  UNIQUE (generation_id, number)
);

CREATE INDEX IF NOT EXISTS generation_attempts_scope_generation_idx
  ON viby.generation_attempts (tenant_id, user_id, generation_id, number);

INSERT INTO viby.generation_attempts (
  id, tenant_id, user_id, generation_id, number, reason, status,
  model_provider, model_id, input_tokens, output_tokens, total_tokens,
  finish_reason, error, created_at, started_at, completed_at
)
SELECT
  generation.id,
  generation.tenant_id,
  generation.user_id,
  generation.id,
  1,
  'initial',
  generation.status,
  generation.model_provider,
  generation.model_id,
  generation.input_tokens,
  generation.output_tokens,
  generation.total_tokens,
  generation.finish_reason,
  generation.error,
  generation.created_at,
  generation.created_at,
  generation.completed_at
FROM viby.generations AS generation
ON CONFLICT (id) DO NOTHING;

UPDATE viby.generations
SET active_attempt_id = id
WHERE active_attempt_id IS NULL;

ALTER TABLE viby.generations
  ALTER COLUMN active_attempt_id SET NOT NULL;

ALTER TABLE viby.generations
  DROP CONSTRAINT IF EXISTS generations_active_attempt_fk;

ALTER TABLE viby.generations
  ADD CONSTRAINT generations_active_attempt_fk
  FOREIGN KEY (active_attempt_id) REFERENCES viby.generation_attempts(id) ON DELETE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS viby.generation_events (
  cursor bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  generation_id uuid NOT NULL REFERENCES viby.generations(id) ON DELETE CASCADE,
  attempt_id uuid REFERENCES viby.generation_attempts(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN (
    'generation.created',
    'attempt.queued',
    'attempt.started',
    'output.delta',
    'attempt.waiting',
    'task.created',
    'task.resolved',
    'attempt.interrupted',
    'attempt.succeeded',
    'attempt.failed',
    'attempt.cancelled',
    'generation.succeeded',
    'generation.failed',
    'generation.cancelled'
  )),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS generation_events_scope_cursor_idx
  ON viby.generation_events (tenant_id, user_id, generation_id, cursor);

CREATE TABLE IF NOT EXISTS viby.generation_tasks (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  generation_id uuid NOT NULL REFERENCES viby.generations(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES viby.generation_attempts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('plan', 'question', 'permission')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  title text NOT NULL,
  message text NOT NULL,
  payload jsonb NOT NULL,
  resolution jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (tenant_id, user_id, id)
);

CREATE INDEX IF NOT EXISTS generation_tasks_scope_generation_idx
  ON viby.generation_tasks (tenant_id, user_id, generation_id, created_at, id);
