CREATE TABLE viby.visual_artifacts (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  chat_id uuid NOT NULL REFERENCES viby.chats(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES viby.versions(id) ON DELETE CASCADE,
  page_id text NOT NULL CHECK (char_length(page_id) BETWEEN 1 AND 100),
  path text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 2048),
  url text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2048),
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  media_type text NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg')),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 100000),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 100000),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 25000000),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  artifact_store text NOT NULL CHECK (
    artifact_store ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'
  ),
  artifact_key text NOT NULL CHECK (char_length(artifact_key) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, id)
);

CREATE INDEX visual_artifacts_scope_version_idx
  ON viby.visual_artifacts (tenant_id, user_id, version_id, created_at, id);

CREATE INDEX visual_artifacts_artifact_location_idx
  ON viby.visual_artifacts (artifact_store, artifact_key);
