ALTER TABLE viby.integration_secrets
  DROP CONSTRAINT IF EXISTS integration_secrets_purpose_check;

ALTER TABLE viby.integration_secrets
  ADD CONSTRAINT integration_secrets_purpose_check
  CHECK (purpose IN (
    'authorization-session',
    'integration-credential',
    'environment-variable',
    'tool-source-authorization-session',
    'tool-source-credential',
    'webhook-signing'
  ));

CREATE TABLE viby.webhooks (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  url text NOT NULL,
  event_types text[] CHECK (
    event_types IS NULL OR (
      cardinality(event_types) > 0 AND event_types <@ ARRAY[
        'generation.created', 'attempt.queued', 'attempt.started', 'steering.queued',
        'steering.applied', 'output.delta', 'part.started', 'part.delta',
        'part.completed', 'part.failed', 'artifact.created', 'workspace.started',
        'workspace.prepared', 'preview.ready', 'preview.failed', 'quality.started',
        'quality.completed', 'attempt.waiting', 'task.created', 'task.resolved',
        'attempt.interrupted', 'attempt.succeeded', 'attempt.failed', 'attempt.cancelled',
        'generation.succeeded', 'generation.failed', 'generation.cancelled'
      ]::text[]
    )
  ),
  status text NOT NULL CHECK (status IN ('active', 'paused')),
  key_id text NOT NULL,
  secret_ref text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, user_id, id)
);

CREATE INDEX webhooks_scope_status_idx
  ON viby.webhooks (tenant_id, user_id, status, updated_at DESC, id);

CREATE TABLE viby.webhook_delivery_cursors (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  webhook_id uuid NOT NULL REFERENCES viby.webhooks(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES viby.generations(id) ON DELETE CASCADE,
  cursor bigint NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, user_id, webhook_id, generation_id),
  FOREIGN KEY (tenant_id, user_id, webhook_id)
    REFERENCES viby.webhooks(tenant_id, user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id, generation_id)
    REFERENCES viby.generations(tenant_id, user_id, id) ON DELETE CASCADE
);
