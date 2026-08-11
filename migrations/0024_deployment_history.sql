CREATE TABLE viby.deployment_project_links (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  chat_id uuid NOT NULL REFERENCES viby.chats(id) ON DELETE CASCADE,
  integration_id text NOT NULL CHECK (
    integration_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'
  ),
  connection_id text NOT NULL CHECK (char_length(connection_id) BETWEEN 1 AND 500),
  provider text NOT NULL CHECK (
    provider ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'
  ),
  provider_project_id text NOT NULL CHECK (char_length(provider_project_id) BETWEEN 1 AND 500),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 500),
  url text CHECK (url IS NULL OR char_length(url) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (
    tenant_id, user_id, chat_id, integration_id, connection_id, provider_project_id
  ),
  UNIQUE (tenant_id, user_id, id)
);

CREATE INDEX deployment_project_links_scope_chat_idx
  ON viby.deployment_project_links (
    tenant_id, user_id, chat_id, updated_at DESC, id DESC
  );

CREATE TABLE viby.deployments (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  chat_id uuid NOT NULL REFERENCES viby.chats(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES viby.versions(id) ON DELETE CASCADE,
  project_link_id uuid REFERENCES viby.deployment_project_links(id) ON DELETE SET NULL,
  integration_id text NOT NULL CHECK (
    integration_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'
  ),
  connection_id text NOT NULL CHECK (char_length(connection_id) BETWEEN 1 AND 500),
  provider text NOT NULL CHECK (
    provider ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'
  ),
  project_target text NOT NULL CHECK (char_length(project_target) BETWEEN 1 AND 1000),
  environment text NOT NULL CHECK (char_length(environment) BETWEEN 1 AND 100),
  provider_deployment_id text,
  provider_created_at timestamptz,
  url text CHECK (url IS NULL OR char_length(url) BETWEEN 1 AND 2000),
  status text NOT NULL CHECK (
    status IN ('pending', 'queued', 'building', 'ready', 'failed', 'cancelled')
  ),
  error text,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (tenant_id, user_id, idempotency_key),
  UNIQUE (tenant_id, user_id, id),
  CHECK (
    (status = 'pending' AND provider_deployment_id IS NULL)
    OR status = 'failed'
    OR (
      status IN ('queued', 'building', 'ready', 'cancelled')
      AND provider_deployment_id IS NOT NULL
    )
  ),
  CHECK ((status IN ('ready', 'failed', 'cancelled')) = (completed_at IS NOT NULL))
);

CREATE INDEX deployments_scope_chat_idx
  ON viby.deployments (tenant_id, user_id, chat_id, created_at DESC, id DESC);

CREATE INDEX deployments_scope_version_idx
  ON viby.deployments (tenant_id, user_id, version_id, created_at DESC, id DESC);

CREATE INDEX deployments_provider_identity_idx
  ON viby.deployments (
    tenant_id, user_id, integration_id, connection_id, provider, provider_deployment_id
  ) WHERE provider_deployment_id IS NOT NULL;

CREATE TABLE viby.deployment_status_transitions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  deployment_id uuid NOT NULL REFERENCES viby.deployments(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (
    status IN ('pending', 'queued', 'building', 'ready', 'failed', 'cancelled')
  ),
  url text CHECK (url IS NULL OR char_length(url) BETWEEN 1 AND 2000),
  error text,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, user_id, id)
);

CREATE INDEX deployment_status_transitions_scope_idx
  ON viby.deployment_status_transitions (
    tenant_id, user_id, deployment_id, created_at, id
  );
