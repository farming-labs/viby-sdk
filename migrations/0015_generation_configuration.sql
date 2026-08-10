ALTER TABLE viby.generations
  ADD COLUMN configuration jsonb NOT NULL DEFAULT
    '{"model":"default","instructions":null,"skills":{},"metadata":{}}'::jsonb;

ALTER TABLE viby.generations
  ADD CONSTRAINT generations_configuration_is_object
  CHECK (jsonb_typeof(configuration) = 'object');
