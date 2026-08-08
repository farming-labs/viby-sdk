ALTER TABLE viby.versions
  ALTER COLUMN generation_id DROP NOT NULL;

ALTER TABLE viby.versions
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'generated';

ALTER TABLE viby.versions
  DROP CONSTRAINT IF EXISTS versions_origin_check;

ALTER TABLE viby.versions
  ADD CONSTRAINT versions_origin_check
  CHECK (origin IN ('generated', 'imported', 'edited', 'forked', 'restored'));
