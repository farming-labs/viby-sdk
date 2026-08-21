ALTER TABLE viby.generation_events
  DROP CONSTRAINT IF EXISTS generation_events_type_check;

ALTER TABLE viby.generation_events
  ADD CONSTRAINT generation_events_type_check CHECK (type IN (
    'generation.created',
    'attempt.queued',
    'attempt.started',
    'steering.queued',
    'steering.applied',
    'output.delta',
    'part.started',
    'part.delta',
    'part.completed',
    'part.failed',
    'artifact.created',
    'workspace.started',
    'workspace.prepared',
    'preview.ready',
    'preview.failed',
    'quality.started',
    'quality.completed',
    'attempt.waiting',
    'task.created',
    'task.resolved',
    'attempt.interrupted',
    'attempt.succeeded',
    'attempt.failed',
    'attempt.cancelled',
    'generation.succeeded',
    'generation.failed',
    'generation.cancelled'
  ));
