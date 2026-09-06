-- Server-owned diagnostics, pinned to each checkpoint's published SHA.
-- Existing owner SELECT RLS and server-only writes remain in force.
ALTER TABLE public.checkpoints ADD COLUMN IF NOT EXISTS validation_feedback jsonb;
ALTER TABLE public.checkpoints ADD COLUMN IF NOT EXISTS validation_failure jsonb;
ALTER TABLE public.checkpoints ADD COLUMN IF NOT EXISTS validation_success jsonb;
ALTER TABLE public.checkpoints ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_checkpoints_validation_failure
  ON public.checkpoints (project_id, created_at DESC) WHERE validation_failure IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_checkpoints_validation_success
  ON public.checkpoints (project_id, created_at DESC) WHERE validation_success IS NOT NULL;
COMMENT ON COLUMN public.checkpoints.validation_feedback IS
  'Sanitized CI evidence for this checkpoint and published SHA; never merge authority.';
