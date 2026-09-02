ALTER TABLE viby.webhooks
  ADD COLUMN delivery_start_cursor bigint NOT NULL DEFAULT 0 CHECK (delivery_start_cursor >= 0);

-- Existing endpoints retain the pre-worker cursor semantics and therefore start
-- at zero. Using timestamps to infer an endpoint's creation cursor can skip an
-- event inserted by a transaction whose timestamp predates the endpoint.

CREATE INDEX generation_events_webhook_discovery_idx
  ON viby.generation_events (tenant_id, user_id, cursor, generation_id);
