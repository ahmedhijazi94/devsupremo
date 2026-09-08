-- Durable, device-affine restore delivery. A lost poll/report never consumes a
-- request permanently; leases are re-delivered to the original workstation.
ALTER TABLE public.checkpoint_restore_requests
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS result_commit_sha TEXT;
CREATE INDEX IF NOT EXISTS idx_restore_requests_device_lease
  ON public.checkpoint_restore_requests(device_id, status, lease_expires_at);

CREATE OR REPLACE FUNCTION public.claim_checkpoint_restore(p_project_id UUID, p_device_id UUID)
RETURNS SETOF public.checkpoint_restore_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE chosen public.checkpoint_restore_requests; owner_id UUID;
BEGIN
  SELECT p.user_id INTO owner_id FROM public.projects p WHERE p.id=p_project_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.checkpoint_devices d
      WHERE d.id=p_device_id AND d.owner_user_id=owner_id AND d.revoked_at IS NULL) THEN RETURN; END IF;
  -- One outstanding restore per project; don't overtake an active lease.
  SELECT r.* INTO chosen FROM public.checkpoint_restore_requests r
    WHERE r.project_id=p_project_id AND r.status IN ('pending','claimed')
    ORDER BY r.created_at, r.id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF chosen.status='claimed' AND (chosen.device_id IS DISTINCT FROM p_device_id
      OR chosen.lease_expires_at > clock_timestamp()) THEN RETURN; END IF;
  -- The local commit is currently available only on its original workstation.
  IF NOT EXISTS (SELECT 1 FROM public.checkpoints c WHERE c.id=chosen.target_checkpoint_id
      AND c.project_id=p_project_id AND c.device_id=p_device_id
      AND c.push_status IN ('published','integrated') AND c.published_sha IS NOT NULL) THEN RETURN; END IF;
  RETURN QUERY UPDATE public.checkpoint_restore_requests SET status='claimed', device_id=p_device_id,
      claim_token=coalesce(chosen.claim_token,gen_random_uuid()), lease_expires_at=clock_timestamp()+interval '10 minutes'
    WHERE id=chosen.id RETURNING *;
END; $$;

CREATE OR REPLACE FUNCTION public.finish_checkpoint_restore(
  p_id UUID, p_project_id UUID, p_device_id UUID, p_claim_token UUID,
  p_status TEXT, p_result_id UUID, p_result_sha TEXT, p_error TEXT
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE existing public.checkpoint_restore_requests; owner_id UUID; reported TEXT; result_row public.checkpoints;
BEGIN
  SELECT p.user_id INTO owner_id FROM public.projects p WHERE p.id=p_project_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.checkpoint_devices d WHERE d.id=p_device_id
      AND d.owner_user_id=owner_id AND d.revoked_at IS NULL) THEN RETURN 'conflict'; END IF;
  SELECT * INTO existing FROM public.checkpoint_restore_requests WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR existing.project_id<>p_project_id OR existing.device_id IS DISTINCT FROM p_device_id
    OR existing.claim_token IS NULL OR existing.claim_token IS DISTINCT FROM p_claim_token
    OR p_status NOT IN ('applied','failed') THEN RETURN 'conflict'; END IF;
  IF (p_status='applied' AND ((p_result_id IS NULL)<>(p_result_sha IS NULL)
      OR (p_result_sha IS NOT NULL AND p_result_sha !~ '^[a-f0-9]{40}$')))
    OR (p_status='failed' AND (p_result_id IS NOT NULL OR p_result_sha IS NOT NULL OR p_error IS NULL
      OR length(p_error) NOT BETWEEN 1 AND 500)) THEN RETURN 'conflict'; END IF;
  IF existing.status IN ('applied','failed') THEN
    IF existing.status=p_status AND existing.result_checkpoint_id IS NOT DISTINCT FROM p_result_id
      AND existing.result_commit_sha IS NOT DISTINCT FROM p_result_sha
      AND existing.error IS NOT DISTINCT FROM (CASE WHEN p_status='failed' THEN p_error ELSE NULL END)
      THEN RETURN 'acknowledged'; END IF;
    RETURN 'conflict';
  END IF;
  IF existing.status<>'claimed' THEN RETURN 'conflict'; END IF;
  -- Register only bounded local metadata inside the same transaction, before
  -- linking its FK. This is not source publication, validation, or integration.
  IF p_result_id IS NOT NULL THEN
    SELECT * INTO result_row FROM public.checkpoints WHERE id=p_result_id FOR UPDATE;
    IF FOUND AND (p_result_id=existing.target_checkpoint_id
      OR result_row.project_id<>p_project_id OR result_row.device_id IS DISTINCT FROM p_device_id
      OR result_row.commit_sha<>p_result_sha
      OR (result_row.restored_from_checkpoint_id IS NOT NULL AND result_row.restored_from_checkpoint_id<>existing.target_checkpoint_id)
      OR (result_row.push_status<>'local' AND result_row.restored_from_checkpoint_id IS DISTINCT FROM existing.target_checkpoint_id))
      THEN RETURN 'conflict'; END IF;
    reported := public.report_local_checkpoint(p_result_id,p_project_id,p_device_id,p_result_sha,
      clock_timestamp(),1,'pending',NULL,'local');
    IF reported='conflict' THEN RETURN 'conflict'; END IF;
    SELECT * INTO result_row FROM public.checkpoints WHERE id=p_result_id FOR UPDATE;
    IF p_result_id=existing.target_checkpoint_id OR (result_row.restored_from_checkpoint_id IS NOT NULL
      AND result_row.restored_from_checkpoint_id<>existing.target_checkpoint_id) THEN RETURN 'conflict'; END IF;
    UPDATE public.checkpoints SET restored_from_checkpoint_id=existing.target_checkpoint_id WHERE id=p_result_id;
  END IF;
  UPDATE public.checkpoint_restore_requests SET status=p_status, result_checkpoint_id=p_result_id,
    result_commit_sha=p_result_sha, error=CASE WHEN p_status='failed' THEN p_error ELSE NULL END,
    lease_expires_at=NULL WHERE id=p_id;
  RETURN 'acknowledged';
END; $$;
REVOKE ALL ON FUNCTION public.claim_checkpoint_restore(UUID,UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_checkpoint_restore(UUID,UUID,UUID,UUID,TEXT,UUID,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_checkpoint_restore(UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_checkpoint_restore(UUID,UUID,UUID,UUID,TEXT,UUID,TEXT,TEXT) TO service_role;

-- Users create only pending requests; claim/result fields are server-owned.
DROP POLICY IF EXISTS restore_requests_owner_insert ON public.checkpoint_restore_requests;
CREATE POLICY restore_requests_owner_insert ON public.checkpoint_restore_requests FOR INSERT WITH CHECK (
  requested_by=auth.uid() AND status='pending' AND device_id IS NULL AND claim_token IS NULL
  AND lease_expires_at IS NULL AND result_checkpoint_id IS NULL AND result_commit_sha IS NULL AND error IS NULL
  AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id=project_id AND p.user_id=auth.uid())
  AND EXISTS (SELECT 1 FROM public.checkpoints c WHERE c.id=target_checkpoint_id
    AND c.project_id=checkpoint_restore_requests.project_id
    AND c.push_status IN ('published','integrated') AND c.published_sha IS NOT NULL)
);
