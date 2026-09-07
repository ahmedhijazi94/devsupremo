-- Status-only reporting is independent from source publication. RLS is retained.
ALTER TABLE public.checkpoints DROP CONSTRAINT IF EXISTS checkpoints_push_status_check;
ALTER TABLE public.checkpoints ADD CONSTRAINT checkpoints_push_status_check
  CHECK (push_status IN ('local', 'publishing', 'published', 'integrated', 'failed'));
ALTER TABLE public.checkpoints
  ADD COLUMN IF NOT EXISTS local_validation_status TEXT
    CHECK (local_validation_status IN ('pending', 'running', 'passed', 'failed', 'deferred')),
  ADD COLUMN IF NOT EXISTS local_upload_status TEXT
    CHECK (local_upload_status IN ('local', 'upload_pending', 'push_failed')),
  ADD COLUMN IF NOT EXISTS local_validated_sha TEXT,
  ADD COLUMN IF NOT EXISTS local_report_revision BIGINT NOT NULL DEFAULT 0 CHECK (local_report_revision >= 0),
  ADD COLUMN IF NOT EXISTS local_reported_at TIMESTAMPTZ;

-- No caller-authored prompt, file, log, repository, branch or approval is accepted.
-- The service route checks ownership, repeated here so a future caller cannot omit it.
CREATE OR REPLACE FUNCTION public.report_local_checkpoint(
  p_id UUID, p_project_id UUID, p_device_id UUID, p_commit_sha TEXT,
  p_created_at TIMESTAMPTZ, p_revision BIGINT, p_validation_status TEXT,
  p_validated_sha TEXT, p_upload_status TEXT
) RETURNS TEXT
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE existing public.checkpoints%ROWTYPE;
BEGIN
  IF p_commit_sha !~ '^[a-f0-9]{40}$' OR p_revision < 1
    OR p_validation_status NOT IN ('pending', 'running', 'passed', 'failed', 'deferred')
    OR p_upload_status NOT IN ('local', 'upload_pending', 'push_failed')
    OR (p_validated_sha IS NOT NULL AND p_validated_sha <> p_commit_sha)
    OR (p_validation_status IN ('passed', 'deferred') AND p_validated_sha IS DISTINCT FROM p_commit_sha)
    OR NOT EXISTS (
      SELECT 1 FROM public.projects p JOIN public.checkpoint_devices d
        ON d.owner_user_id = p.user_id
      WHERE p.id = p_project_id AND d.id = p_device_id AND d.revoked_at IS NULL
    ) THEN RETURN 'conflict'; END IF;

  INSERT INTO public.checkpoints (
    id, project_id, device_id, commit_sha, summary, push_status, created_at
  ) VALUES (
    p_id, p_project_id, p_device_id, p_commit_sha,
    'Alteração salva no computador', 'local', LEAST(p_created_at, now())
  ) ON CONFLICT (id) DO NOTHING;

  SELECT * INTO existing FROM public.checkpoints WHERE id = p_id FOR UPDATE;
  IF existing.project_id <> p_project_id OR existing.device_id IS DISTINCT FROM p_device_id
    OR existing.commit_sha <> p_commit_sha THEN RETURN 'conflict'; END IF;
  -- A late retry can neither roll back publication/integration nor newer local evidence.
  IF existing.push_status <> 'local' OR existing.local_report_revision >= p_revision
    THEN RETURN 'ignored'; END IF;
  UPDATE public.checkpoints SET
    local_validation_status = p_validation_status, local_upload_status = p_upload_status,
    local_validated_sha = p_validated_sha, local_report_revision = p_revision,
    local_reported_at = now()
  WHERE id = p_id;
  RETURN 'recorded';
END;
$$;
REVOKE ALL ON FUNCTION public.report_local_checkpoint(UUID, UUID, UUID, TEXT, TIMESTAMPTZ, BIGINT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_local_checkpoint(UUID, UUID, UUID, TEXT, TIMESTAMPTZ, BIGINT, TEXT, TEXT, TEXT)
  TO service_role;

-- A metadata-only record is not yet a portable restore target. Authenticated
-- clients cannot bypass the UI to request one, or cross project boundaries.
DROP POLICY IF EXISTS restore_requests_owner_insert ON public.checkpoint_restore_requests;
CREATE POLICY restore_requests_owner_insert ON public.checkpoint_restore_requests
  FOR INSERT WITH CHECK (
    requested_by = auth.uid()
    AND EXISTS (SELECT 1 FROM public.projects p
      WHERE p.id = checkpoint_restore_requests.project_id AND p.user_id = auth.uid())
    AND EXISTS (SELECT 1 FROM public.checkpoints c
      WHERE c.id = checkpoint_restore_requests.target_checkpoint_id
        AND c.project_id = checkpoint_restore_requests.project_id
        AND c.push_status IN ('published', 'integrated') AND c.published_sha IS NOT NULL)
  );
