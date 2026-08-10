CREATE TABLE viby.project_artifacts (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  media_type text NOT NULL CHECK (char_length(media_type) BETWEEN 3 AND 200),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 25000000),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  artifact_store text NOT NULL CHECK (
    artifact_store ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'
  ),
  artifact_key text NOT NULL CHECK (char_length(artifact_key) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, id)
);

CREATE INDEX project_artifacts_scope_idx
  ON viby.project_artifacts (tenant_id, user_id, created_at, id);

CREATE INDEX project_artifacts_location_idx
  ON viby.project_artifacts (artifact_store, artifact_key);

ALTER TABLE viby.version_files
  ADD COLUMN kind text NOT NULL DEFAULT 'text',
  ADD COLUMN artifact_id uuid REFERENCES viby.project_artifacts(id) ON DELETE RESTRICT,
  ALTER COLUMN content DROP NOT NULL,
  ADD CONSTRAINT version_files_kind_check CHECK (kind IN ('text', 'artifact')),
  ADD CONSTRAINT version_files_content_check CHECK (
    (kind = 'text' AND content IS NOT NULL AND artifact_id IS NULL)
    OR (kind = 'artifact' AND content IS NULL AND artifact_id IS NOT NULL)
  );

CREATE INDEX version_files_artifact_idx
  ON viby.version_files (tenant_id, user_id, artifact_id)
  WHERE artifact_id IS NOT NULL;
