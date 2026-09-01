ALTER TABLE viby.message_feedback
  ADD COLUMN framework text,
  ADD COLUMN executor text,
  ADD COLUMN runtime_alias text,
  ADD COLUMN skills jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN version_number integer;

UPDATE viby.message_feedback AS feedback
SET
  framework = chat.framework,
  executor = CASE
    WHEN generation.configuration->>'executor' IN ('engine', 'agent') THEN 'engine'
    ELSE 'model'
  END,
  runtime_alias = COALESCE(generation.configuration->>'model', 'default'),
  skills = COALESCE(generation.configuration->'skills', '{}'::jsonb),
  version_number = version.number
FROM viby.chats AS chat
JOIN viby.generations AS generation ON generation.chat_id = chat.id
LEFT JOIN viby.versions AS version ON version.generation_id = generation.id
WHERE feedback.chat_id = chat.id AND feedback.generation_id = generation.id;

ALTER TABLE viby.message_feedback
  ALTER COLUMN framework SET NOT NULL,
  ALTER COLUMN executor SET NOT NULL,
  ALTER COLUMN runtime_alias SET NOT NULL,
  ADD CONSTRAINT message_feedback_executor_check CHECK (executor IN ('model', 'engine')),
  ADD CONSTRAINT message_feedback_skills_is_object CHECK (jsonb_typeof(skills) = 'object');

CREATE INDEX IF NOT EXISTS message_feedback_analytics_idx
  ON viby.message_feedback (
    tenant_id, user_id, created_at, framework, model_provider, model_id, runtime_alias
  );

CREATE TABLE IF NOT EXISTS viby.message_feedback_selections (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  chat_id uuid NOT NULL REFERENCES viby.chats(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES viby.messages(id) ON DELETE CASCADE,
  feedback_id uuid NOT NULL REFERENCES viby.message_feedback(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, message_id)
);

INSERT INTO viby.message_feedback_selections (
  tenant_id, user_id, chat_id, message_id, feedback_id, updated_at
)
SELECT DISTINCT ON (tenant_id, user_id, message_id)
  tenant_id, user_id, chat_id, message_id, id, created_at
FROM viby.message_feedback
ORDER BY tenant_id, user_id, message_id, created_at DESC, id DESC
ON CONFLICT (tenant_id, user_id, message_id) DO NOTHING;
