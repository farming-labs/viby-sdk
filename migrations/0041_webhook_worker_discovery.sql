ALTER TABLE viby.webhooks
  ADD COLUMN delivery_start_cursor bigint NOT NULL DEFAULT 0 CHECK (delivery_start_cursor >= 0);

UPDATE viby.webhooks AS webhook
SET delivery_start_cursor = COALESCE((
  SELECT MAX(event.cursor)
  FROM viby.generation_events AS event
  WHERE event.tenant_id = webhook.tenant_id
    AND event.user_id = webhook.user_id
    AND event.created_at <= webhook.created_at
), 0);

CREATE INDEX webhook_delivery_cursors_generation_idx
  ON viby.webhook_delivery_cursors (generation_id, webhook_id, cursor);
