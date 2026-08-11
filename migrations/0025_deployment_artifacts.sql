CREATE TABLE viby.deployment_artifacts (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  chat_id uuid NOT NULL REFERENCES viby.chats(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES viby.versions(id) ON DELETE CASCADE,
  deployment_id uuid NOT NULL REFERENCES viby.deployments(id) ON DELETE CASCADE,
  framework text NOT NULL CHECK (char_length(framework) BETWEEN 1 AND 200),
  sandbox_provider text NOT NULL CHECK (
    sandbox_provider ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'
  ),
  output_directory text NOT NULL CHECK (char_length(output_directory) BETWEEN 1 AND 1000),
  commands jsonb NOT NULL CHECK (jsonb_typeof(commands) = 'array'),
  file_count integer NOT NULL CHECK (file_count > 0),
  media_type text NOT NULL DEFAULT 'application/zip' CHECK (media_type = 'application/zip'),
  size integer NOT NULL CHECK (size > 0),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  artifact_store text NOT NULL CHECK (char_length(artifact_store) BETWEEN 1 AND 100),
  artifact_key text NOT NULL CHECK (char_length(artifact_key) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, user_id, deployment_id),
  UNIQUE (tenant_id, user_id, id)
);

CREATE INDEX deployment_artifacts_scope_version_idx
  ON viby.deployment_artifacts (tenant_id, user_id, version_id, created_at DESC, id DESC);

CREATE INDEX deployment_artifacts_store_key_idx
  ON viby.deployment_artifacts (artifact_store, artifact_key);

ALTER TABLE viby.deployments
  ADD COLUMN preparation_artifact_id uuid REFERENCES viby.deployment_artifacts(id) ON DELETE SET NULL;
