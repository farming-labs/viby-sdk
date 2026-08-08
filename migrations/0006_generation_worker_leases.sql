ALTER TABLE viby.generation_attempts
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

CREATE INDEX IF NOT EXISTS generation_attempts_claim_idx
  ON viby.generation_attempts (status, lease_expires_at, created_at)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS generation_attempts_worker_idx
  ON viby.generation_attempts (worker_id, lease_expires_at)
  WHERE lease_token IS NOT NULL;
