ALTER TABLE viby.skill_snapshots
  DROP CONSTRAINT IF EXISTS skill_snapshots_source_check;

ALTER TABLE viby.skill_snapshots
  ADD CONSTRAINT skill_snapshots_source_check
  CHECK (length(btrim(source)) BETWEEN 1 AND 500);
