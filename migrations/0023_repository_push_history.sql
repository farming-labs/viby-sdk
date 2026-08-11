CREATE TABLE viby.repository_links (
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
  provider_repository_id text NOT NULL CHECK (
    char_length(provider_repository_id) BETWEEN 1 AND 500
  ),
  owner text NOT NULL CHECK (char_length(owner) BETWEEN 1 AND 500),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 500),
  default_branch text NOT NULL CHECK (char_length(default_branch) BETWEEN 1 AND 500),
  visibility text NOT NULL CHECK (visibility IN ('private', 'internal', 'public')),
  url text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (
    tenant_id, user_id, chat_id, integration_id, connection_id, provider_repository_id
  ),
  UNIQUE (tenant_id, user_id, id)
);

CREATE INDEX repository_links_scope_chat_idx
  ON viby.repository_links (tenant_id, user_id, chat_id, updated_at DESC, id DESC);

CREATE TABLE viby.repository_pushes (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  chat_id uuid NOT NULL REFERENCES viby.chats(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES viby.versions(id) ON DELETE CASCADE,
  repository_link_id uuid REFERENCES viby.repository_links(id) ON DELETE SET NULL,
  integration_id text NOT NULL CHECK (
    integration_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'
  ),
  connection_id text NOT NULL CHECK (char_length(connection_id) BETWEEN 1 AND 500),
  provider text NOT NULL CHECK (
    provider ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'
  ),
  repository_owner text NOT NULL CHECK (char_length(repository_owner) BETWEEN 1 AND 500),
  repository_name text NOT NULL CHECK (char_length(repository_name) BETWEEN 1 AND 500),
  branch text NOT NULL CHECK (char_length(branch) BETWEEN 1 AND 500),
  commit_message text NOT NULL CHECK (char_length(commit_message) BETWEEN 1 AND 10000),
  expected_head text,
  status text NOT NULL CHECK (status IN ('pending', 'pushed', 'conflict', 'failed')),
  commit jsonb,
  changed_files integer CHECK (changed_files >= 0),
  pull_request jsonb,
  actual_head text,
  error text,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (tenant_id, user_id, idempotency_key),
  UNIQUE (tenant_id, user_id, id),
  CHECK ((status = 'pending') = (completed_at IS NULL)),
  CHECK ((status = 'pushed') = (commit IS NOT NULL)),
  CHECK ((status = 'conflict') = (actual_head IS NOT NULL)),
  CHECK ((status = 'failed') = (error IS NOT NULL))
);

CREATE INDEX repository_pushes_scope_chat_idx
  ON viby.repository_pushes (tenant_id, user_id, chat_id, created_at DESC, id DESC);

CREATE INDEX repository_pushes_scope_version_idx
  ON viby.repository_pushes (tenant_id, user_id, version_id, created_at DESC, id DESC);
