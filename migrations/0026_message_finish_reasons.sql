ALTER TABLE viby.messages
  ADD COLUMN IF NOT EXISTS finish_reason text;
