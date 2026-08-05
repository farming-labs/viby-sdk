CREATE SCHEMA IF NOT EXISTS viby;

CREATE TABLE IF NOT EXISTS viby.chats (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  title text NOT NULL,
  framework text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, id)
);

CREATE INDEX IF NOT EXISTS chats_scope_updated_idx
  ON viby.chats (tenant_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS viby.generations (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  chat_id uuid NOT NULL REFERENCES viby.chats(id) ON DELETE CASCADE,
  base_version_id uuid,
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  model_provider text NOT NULL,
  model_id text NOT NULL,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  finish_reason text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, user_id, id)
);

CREATE INDEX IF NOT EXISTS generations_scope_chat_idx
  ON viby.generations (tenant_id, user_id, chat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS viby.messages (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  chat_id uuid NOT NULL REFERENCES viby.chats(id) ON DELETE CASCADE,
  generation_id uuid REFERENCES viby.generations(id) ON DELETE SET NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, id)
);

CREATE INDEX IF NOT EXISTS messages_scope_chat_idx
  ON viby.messages (tenant_id, user_id, chat_id, created_at, id);

CREATE TABLE IF NOT EXISTS viby.versions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  chat_id uuid NOT NULL REFERENCES viby.chats(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL UNIQUE REFERENCES viby.generations(id) ON DELETE CASCADE,
  parent_version_id uuid REFERENCES viby.versions(id) ON DELETE SET NULL,
  number integer NOT NULL CHECK (number > 0),
  framework text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, id),
  UNIQUE (chat_id, number)
);

CREATE INDEX IF NOT EXISTS versions_scope_chat_idx
  ON viby.versions (tenant_id, user_id, chat_id, number DESC);

ALTER TABLE viby.generations
  DROP CONSTRAINT IF EXISTS generations_base_version_fk;

ALTER TABLE viby.generations
  ADD CONSTRAINT generations_base_version_fk
  FOREIGN KEY (base_version_id) REFERENCES viby.versions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS viby.version_files (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  version_id uuid NOT NULL REFERENCES viby.versions(id) ON DELETE CASCADE,
  path text NOT NULL,
  content text NOT NULL,
  media_type text NOT NULL,
  size integer NOT NULL CHECK (size >= 0),
  checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, path)
);

CREATE INDEX IF NOT EXISTS version_files_scope_version_idx
  ON viby.version_files (tenant_id, user_id, version_id, path);

CREATE TABLE IF NOT EXISTS viby.skill_snapshots (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('skills.sh', 'file')),
  locator text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  content_hash text NOT NULL,
  files jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, content_hash)
);

CREATE TABLE IF NOT EXISTS viby.generation_skills (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  generation_id uuid NOT NULL REFERENCES viby.generations(id) ON DELETE CASCADE,
  skill_snapshot_id uuid NOT NULL REFERENCES viby.skill_snapshots(id) ON DELETE RESTRICT,
  category text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  activation text NOT NULL DEFAULT 'automatic' CHECK (activation IN ('always', 'automatic', 'explicit')),
  PRIMARY KEY (generation_id, skill_snapshot_id, category)
);

CREATE INDEX IF NOT EXISTS generation_skills_scope_idx
  ON viby.generation_skills (tenant_id, user_id, generation_id, position);
