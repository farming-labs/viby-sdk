CREATE TABLE IF NOT EXISTS viby.tool_sources (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  type text NOT NULL CHECK (type ~ '^[a-z][a-z0-9-]{0,63}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR char_length(description) <= 1000),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(configuration) = 'object'),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'archived')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, user_id, id)
);

CREATE TABLE IF NOT EXISTS viby.chat_tool_sources (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  chat_id uuid NOT NULL,
  tool_source_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, user_id, chat_id, tool_source_id),
  FOREIGN KEY (tenant_id, user_id, chat_id)
    REFERENCES viby.chats(tenant_id, user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id, tool_source_id)
    REFERENCES viby.tool_sources(tenant_id, user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tool_sources_scope_status_idx
  ON viby.tool_sources (tenant_id, user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS chat_tool_sources_source_idx
  ON viby.chat_tool_sources (tenant_id, user_id, tool_source_id, chat_id);
