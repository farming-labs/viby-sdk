ALTER TABLE viby.attachments
  ADD COLUMN artifact_store text,
  ADD COLUMN artifact_key text,
  ALTER COLUMN content DROP NOT NULL;

UPDATE viby.attachments
SET artifact_store = 'postgres-legacy', artifact_key = id::text;

ALTER TABLE viby.attachments
  ALTER COLUMN artifact_store SET NOT NULL,
  ALTER COLUMN artifact_key SET NOT NULL,
  ADD CONSTRAINT attachments_artifact_store_check
    CHECK (artifact_store ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'),
  ADD CONSTRAINT attachments_artifact_key_check
    CHECK (char_length(artifact_key) BETWEEN 1 AND 1000),
  ADD CONSTRAINT attachments_content_location_check
    CHECK (
      (artifact_store = 'postgres-legacy' AND content IS NOT NULL)
      OR (artifact_store <> 'postgres-legacy' AND content IS NULL)
    );

CREATE INDEX attachments_artifact_location_idx
  ON viby.attachments (artifact_store, artifact_key);
