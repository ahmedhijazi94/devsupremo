-- A one-time grant supplements one missing capability. It cannot enable a
-- disabled policy, expand its limits, change its revision or revive a device.
CREATE TABLE public.project_operation_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  policy_id uuid NOT NULL REFERENCES public.project_automation_policies(id) ON DELETE RESTRICT,
  policy_revision uuid NOT NULL,
  environment text NOT NULL CHECK(environment IN ('development','production')),
  device_id uuid REFERENCES public.checkpoint_devices(id) ON DELETE RESTRICT,
  owner_session boolean NOT NULL,
  project_ref text NOT NULL,
  account_id uuid,
  input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
  capability text NOT NULL,
  resource text NOT NULL,
  affected_rows integer CHECK(affected_rows BETWEEN 0 AND 1000),
  review jsonb NOT NULL CHECK(jsonb_typeof(review)='array' AND jsonb_array_length(review)<=100),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','consumed','rejected','revoked')),
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(owner_session OR device_id IS NOT NULL),
  UNIQUE(operation_id,capability,resource)
);
CREATE INDEX operation_approvals_owner_idx ON public.project_operation_approvals(user_id);
CREATE INDEX operation_approvals_project_idx ON public.project_operation_approvals(project_id,created_at DESC);
CREATE INDEX operation_approvals_policy_idx ON public.project_operation_approvals(policy_id);
CREATE INDEX operation_approvals_device_idx ON public.project_operation_approvals(device_id);
ALTER TABLE public.project_operation_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY operation_approvals_owner_read ON public.project_operation_approvals FOR SELECT TO authenticated
  USING(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.projects p WHERE p.id=project_id AND p.user_id=(SELECT auth.uid())));
REVOKE ALL ON public.project_operation_approvals FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.project_operation_approvals TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.project_operation_approvals TO service_role;

CREATE FUNCTION public.request_operation_approval(p_owner uuid,p_project uuid,p_operation uuid,p_policy uuid,p_revision uuid,p_capability text,p_digest text,p_scope jsonb)
RETURNS SETOF public.project_operation_approvals LANGUAGE plpgsql SET search_path='' AS $$
DECLARE permission public.project_automation_policies; proposal public.project_operation_approvals; target public.projects;
BEGIN
  SELECT * INTO permission FROM public.project_automation_policies WHERE id=p_policy AND user_id=p_owner AND project_id=p_project FOR UPDATE;
  IF NOT FOUND OR NOT permission.enabled OR permission.revision<>p_revision THEN RAISE EXCEPTION 'authorization changed'; END IF;
  SELECT * INTO target FROM public.projects WHERE id=p_project AND user_id=p_owner;
  IF NOT FOUND OR COALESCE(target.supabase_project_ref,'')<>p_scope->>'projectRef' OR target.supabase_account_id IS DISTINCT FROM (p_scope->>'accountId')::uuid THEN RAISE EXCEPTION 'target changed'; END IF;
  IF permission.environment<>p_scope->>'environment' OR (p_scope->>'rows')::integer>permission.max_rows
    OR (cardinality(permission.resources)>0 AND NOT (p_scope->>'resource')=ANY(permission.resources))
    OR (NOT (p_scope->>'ownerSession')::boolean AND cardinality(permission.device_ids)>0 AND NOT (p_scope->>'deviceId')::uuid=ANY(permission.device_ids)) THEN RAISE EXCEPTION 'outside policy scope'; END IF;
  IF NOT (p_scope->>'ownerSession')::boolean AND NOT EXISTS(SELECT 1 FROM public.checkpoint_devices WHERE id=(p_scope->>'deviceId')::uuid AND owner_user_id=p_owner AND revoked_at IS NULL) THEN RAISE EXCEPTION 'device revoked'; END IF;
  IF EXISTS(SELECT 1 FROM public.project_operation_approvals WHERE operation_id=p_operation AND (user_id<>p_owner OR project_id<>p_project OR input_digest<>p_digest)) THEN RAISE EXCEPTION 'operation conflict'; END IF;
  INSERT INTO public.project_operation_approvals(operation_id,user_id,project_id,policy_id,policy_revision,environment,device_id,owner_session,project_ref,account_id,input_digest,capability,resource,affected_rows,review,expires_at)
    VALUES(p_operation,p_owner,p_project,p_policy,p_revision,permission.environment,(p_scope->>'deviceId')::uuid,(p_scope->>'ownerSession')::boolean,p_scope->>'projectRef',(p_scope->>'accountId')::uuid,p_digest,p_capability,p_scope->>'resource',(p_scope->>'rows')::integer,p_scope->'review',LEAST((p_scope->>'expiresAt')::timestamptz,now()+interval '15 minutes'))
    ON CONFLICT(operation_id,capability,resource) DO NOTHING;
  SELECT * INTO proposal FROM public.project_operation_approvals WHERE operation_id=p_operation AND capability=p_capability AND resource=p_scope->>'resource';
  IF proposal.user_id<>p_owner OR proposal.project_id<>p_project OR proposal.input_digest<>p_digest OR proposal.policy_id<>p_policy OR proposal.policy_revision<>p_revision OR proposal.device_id IS DISTINCT FROM (p_scope->>'deviceId')::uuid OR proposal.owner_session<>(p_scope->>'ownerSession')::boolean OR proposal.affected_rows IS DISTINCT FROM (p_scope->>'rows')::integer OR proposal.project_ref<>p_scope->>'projectRef' OR proposal.account_id IS DISTINCT FROM (p_scope->>'accountId')::uuid THEN RAISE EXCEPTION 'approval scope changed'; END IF;
  RETURN NEXT proposal;
END $$;

-- Only the owner-session action calls this service-only RPC. No device route
-- exposes it and authenticated browser clients have no EXECUTE privilege.
CREATE FUNCTION public.decide_operation_approval(p_owner uuid,p_project uuid,p_id uuid,p_decision text)
RETURNS boolean LANGUAGE plpgsql SET search_path='' AS $$
DECLARE proposal public.project_operation_approvals; permission public.project_automation_policies;
BEGIN
  IF p_decision NOT IN ('approved','rejected','revoked') THEN RAISE EXCEPTION 'invalid decision'; END IF;
  SELECT * INTO proposal FROM public.project_operation_approvals WHERE id=p_id AND user_id=p_owner AND project_id=p_project;
  IF NOT FOUND THEN RAISE EXCEPTION 'approval not owned'; END IF;
  SELECT * INTO permission FROM public.project_automation_policies WHERE id=proposal.policy_id AND user_id=p_owner AND project_id=p_project FOR UPDATE;
  IF p_decision='approved' AND (NOT FOUND OR NOT permission.enabled OR permission.revision<>proposal.policy_revision OR proposal.expires_at<=now()) THEN RAISE EXCEPTION 'approval expired or policy changed'; END IF;
  PERFORM 1 FROM public.projects WHERE id=p_project AND user_id=p_owner AND COALESCE(supabase_project_ref,'')=proposal.project_ref AND supabase_account_id IS NOT DISTINCT FROM proposal.account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'target changed'; END IF;
  IF p_decision='approved' AND NOT proposal.owner_session AND NOT EXISTS(SELECT 1 FROM public.checkpoint_devices WHERE id=proposal.device_id AND owner_user_id=p_owner AND revoked_at IS NULL) THEN RAISE EXCEPTION 'device revoked'; END IF;
  UPDATE public.project_operation_approvals SET status=p_decision,approved_at=CASE WHEN p_decision='approved' THEN now() ELSE approved_at END,updated_at=now()
    WHERE id=p_id AND ((p_decision IN ('approved','rejected') AND status='pending') OR (p_decision='revoked' AND status IN ('pending','approved','consumed')));
  IF NOT FOUND THEN RAISE EXCEPTION 'approval already decided'; END IF;
  INSERT INTO public.audit_logs(user_id,action,resource_type,resource_id,metadata) VALUES(p_owner,'automation.operation.'||p_decision,'project',p_project,jsonb_build_object('operationId',proposal.operation_id,'approvalId',p_id,'capability',proposal.capability,'inputDigest',proposal.input_digest,'policyRevision',proposal.policy_revision));
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.claim_backend_operation(p_id uuid,p_owner uuid,p_project uuid,p_policy uuid,p_revision uuid,p_capability text,p_digest text,p_token uuid)
RETURNS SETOF public.project_backend_operations LANGUAGE plpgsql SET search_path='' AS $$
DECLARE permission public.project_automation_policies; existing public.project_backend_operations;
BEGIN
  SELECT * INTO permission FROM public.project_automation_policies WHERE id=p_policy AND user_id=p_owner AND project_id=p_project FOR UPDATE;
  IF NOT FOUND OR NOT permission.enabled OR permission.revision<>p_revision THEN RAISE EXCEPTION 'authorization changed'; END IF;
  PERFORM 1 FROM public.projects WHERE id=p_project AND user_id=p_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'project not owned'; END IF;
  IF NOT p_capability=ANY(permission.capabilities) AND NOT EXISTS(
    SELECT 1 FROM public.project_operation_approvals a JOIN public.projects p ON p.id=a.project_id
    WHERE a.operation_id=p_id AND a.user_id=p_owner AND a.project_id=p_project AND a.policy_id=p_policy AND a.policy_revision=p_revision AND a.input_digest=p_digest AND a.capability=p_capability
    AND a.status IN ('approved','consumed') AND a.expires_at>now() AND a.project_ref=COALESCE(p.supabase_project_ref,'') AND a.account_id IS NOT DISTINCT FROM p.supabase_account_id
    AND (a.owner_session OR EXISTS(SELECT 1 FROM public.checkpoint_devices d WHERE d.id=a.device_id AND d.owner_user_id=p_owner AND d.revoked_at IS NULL))) THEN RAISE EXCEPTION 'operation approval required'; END IF;
  -- A revoked/expired supplementary grant also fences already permitted primary
  -- capabilities (e.g. changing roles additionally requires session revocation).
  IF EXISTS(SELECT 1 FROM public.project_operation_approvals a WHERE a.operation_id=p_id AND a.user_id=p_owner AND a.project_id=p_project AND a.input_digest=p_digest
    AND (a.policy_id<>p_policy OR a.policy_revision<>p_revision OR a.status NOT IN ('approved','consumed') OR a.expires_at<=now())) THEN RAISE EXCEPTION 'approval changed'; END IF;
  SELECT * INTO existing FROM public.project_backend_operations WHERE id=p_id;
  IF FOUND THEN
    IF existing.user_id<>p_owner OR existing.project_id<>p_project OR existing.capability<>p_capability OR existing.input_digest<>p_digest THEN RAISE EXCEPTION 'idempotency key conflict'; END IF;
    IF existing.state IN ('queued','running','verifying') AND existing.lease_expires_at<now() THEN
      UPDATE public.project_backend_operations SET state='uncertain',message='Execução interrompida. Confira o resultado antes de repetir.',updated_at=now() WHERE id=p_id RETURNING * INTO existing;
    END IF;
    RETURN NEXT existing; RETURN;
  END IF;
  IF EXISTS(SELECT 1 FROM public.project_operation_approvals WHERE operation_id=p_id AND status='consumed') THEN RAISE EXCEPTION 'approval already consumed'; END IF;
  IF (SELECT count(*) FROM public.project_backend_operations WHERE policy_id=p_policy AND created_at>now()-interval '1 hour')>=permission.max_operations_per_hour THEN RAISE EXCEPTION 'hourly effect budget exceeded'; END IF;
  UPDATE public.project_operation_approvals SET status='consumed',updated_at=now() WHERE operation_id=p_id AND user_id=p_owner AND project_id=p_project AND input_digest=p_digest AND status='approved';
  RETURN QUERY INSERT INTO public.project_backend_operations(id,user_id,project_id,policy_id,policy_revision,environment,capability,input_digest,state,claim_token,lease_expires_at,message)
    VALUES(p_id,p_owner,p_project,p_policy,p_revision,permission.environment,p_capability,p_digest,'queued',p_token,now()+interval '2 minutes','Operação registrada.') RETURNING *;
END $$;
REVOKE ALL ON FUNCTION public.request_operation_approval(uuid,uuid,uuid,uuid,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.decide_operation_approval(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.request_operation_approval(uuid,uuid,uuid,uuid,uuid,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.decide_operation_approval(uuid,uuid,uuid,text) TO service_role;
