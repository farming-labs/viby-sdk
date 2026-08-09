ALTER TABLE viby.version_files
  ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false;
