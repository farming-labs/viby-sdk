CREATE TABLE viby.generation_steering (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  generation_id uuid NOT NULL REFERENCES viby.generations(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES viby.messages(id) ON DELETE CASCADE,
  submitted_attempt_id uuid NOT NULL REFERENCES viby.generation_attempts(id) ON DELETE CASCADE,
  applied_attempt_id uuid REFERENCES viby.generation_attempts(id) ON DELETE SET NULL,
  prompt text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 100000),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'applied')),
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  UNIQUE (tenant_id, user_id, generation_id, message_id)
);

CREATE UNIQUE INDEX generation_steering_idempotency_idx
  ON viby.generation_steering (tenant_id, user_id, generation_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX generation_steering_pending_idx
  ON viby.generation_steering (tenant_id, user_id, generation_id, created_at, id)
  WHERE status = 'queued';

ALTER TABLE viby.generation_events
  DROP CONSTRAINT IF EXISTS generation_events_type_check;

ALTER TABLE viby.generation_events
  ADD CONSTRAINT generation_events_type_check CHECK (type IN (
    'generation.created',
    'attempt.queued',
    'attempt.started',
    'steering.queued',
    'steering.applied',
    'output.delta',
    'part.started',
    'part.delta',
    'part.completed',
    'part.failed',
    'artifact.created',
    'quality.started',
    'quality.completed',
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
  ));
