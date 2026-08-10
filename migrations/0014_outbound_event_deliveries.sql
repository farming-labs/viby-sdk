CREATE TABLE IF NOT EXISTS viby.outbound_event_deliveries (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  generation_id uuid NOT NULL REFERENCES viby.generations(id) ON DELETE CASCADE,
  event_cursor bigint NOT NULL REFERENCES viby.generation_events(cursor) ON DELETE CASCADE,
  sink_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'delivering', 'delivered', 'dead_lettered')
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts > 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  lease_token uuid,
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  dead_lettered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (generation_id, event_cursor, sink_id),
  CHECK ((status = 'delivering') = (lease_token IS NOT NULL)),
  CHECK ((status = 'dead_lettered') = (dead_lettered_at IS NOT NULL)),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS outbound_event_deliveries_due_idx
  ON viby.outbound_event_deliveries (status, next_attempt_at, generation_id, event_cursor);

CREATE INDEX IF NOT EXISTS outbound_event_deliveries_scope_idx
  ON viby.outbound_event_deliveries (tenant_id, user_id, generation_id, sink_id, event_cursor);
