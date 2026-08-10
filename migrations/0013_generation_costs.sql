ALTER TABLE viby.generations
  ADD COLUMN IF NOT EXISTS estimated_cost_micros bigint,
  ADD COLUMN IF NOT EXISTS cost_currency text;

ALTER TABLE viby.generation_attempts
  ADD COLUMN IF NOT EXISTS estimated_cost_micros bigint,
  ADD COLUMN IF NOT EXISTS cost_currency text;

ALTER TABLE viby.generations
  ADD CONSTRAINT generations_estimated_cost_check
  CHECK (estimated_cost_micros IS NULL OR estimated_cost_micros >= 0),
  ADD CONSTRAINT generations_cost_pair_check
  CHECK ((estimated_cost_micros IS NULL) = (cost_currency IS NULL));

ALTER TABLE viby.generation_attempts
  ADD CONSTRAINT generation_attempts_estimated_cost_check
  CHECK (estimated_cost_micros IS NULL OR estimated_cost_micros >= 0),
  ADD CONSTRAINT generation_attempts_cost_pair_check
  CHECK ((estimated_cost_micros IS NULL) = (cost_currency IS NULL));
