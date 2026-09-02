ALTER TABLE viby.generations
  ADD COLUMN after_generation_id uuid REFERENCES viby.generations(id) ON DELETE CASCADE;

CREATE INDEX generations_follow_up_queue_idx
  ON viby.generations (tenant_id, user_id, chat_id, created_at, id)
  WHERE after_generation_id IS NOT NULL AND status = 'queued';

CREATE INDEX generations_follow_up_dependency_idx
  ON viby.generations (tenant_id, user_id, after_generation_id, created_at, id)
  WHERE after_generation_id IS NOT NULL AND status = 'queued';
