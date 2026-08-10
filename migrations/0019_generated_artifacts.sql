CREATE TABLE viby.generated_artifacts (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  chat_id uuid NOT NULL REFERENCES viby.chats(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES viby.generations(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES viby.generation_attempts(id) ON DELETE CASCADE,
  version_id uuid REFERENCES viby.versions(id) ON DELETE SET NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 19),
  kind text NOT NULL CHECK (kind IN ('image', 'audio', 'video', 'document', 'binary')),
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  media_type text NOT NULL CHECK (char_length(media_type) BETWEEN 3 AND 255),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 25000000),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  artifact_store text NOT NULL CHECK (
    artifact_store ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'
  ),
  artifact_key text NOT NULL CHECK (char_length(artifact_key) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, id),
  UNIQUE (tenant_id, user_id, attempt_id, position)
);

CREATE INDEX generated_artifacts_scope_generation_idx
  ON viby.generated_artifacts (tenant_id, user_id, generation_id, created_at, id);

CREATE INDEX generated_artifacts_artifact_location_idx
  ON viby.generated_artifacts (artifact_store, artifact_key);

ALTER TABLE viby.generation_events
  DROP CONSTRAINT IF EXISTS generation_events_type_check;

ALTER TABLE viby.generation_events
  ADD CONSTRAINT generation_events_type_check CHECK (type IN (
    'generation.created',
    'attempt.queued',
    'attempt.started',
    'output.delta',
    'part.started',
    'part.delta',
    'part.completed',
    'part.failed',
    'artifact.created',
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
