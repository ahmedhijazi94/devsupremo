CREATE TABLE public.project_backend_operations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  policy_id uuid NOT NULL REFERENCES public.project_automation_policies(id) ON DELETE RESTRICT,
  policy_revision uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development','production')),
  capability text NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('queued','running','verifying','succeeded','failed','uncertain','cancelled')),
  claim_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  message text NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_backend_operations_user_idx ON public.project_backend_operations(user_id);
CREATE INDEX project_backend_operations_project_idx ON public.project_backend_operations(project_id,created_at DESC);
CREATE INDEX project_backend_operations_policy_idx ON public.project_backend_operations(policy_id,created_at DESC);
ALTER TABLE public.project_backend_operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY backend_operation_owner_read ON public.project_backend_operations FOR SELECT TO authenticated
  USING (user_id=(SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id=project_id AND p.user_id=(SELECT auth.uid())));
REVOKE ALL ON public.project_backend_operations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.project_backend_operations TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.project_backend_operations TO service_role;

-- Row lock serializes the shared hourly budget across server instances.
-- An existing operation can be read, but never claimed for a second dispatch.
CREATE FUNCTION public.claim_backend_operation(p_id uuid,p_owner uuid,p_project uuid,p_policy uuid,p_revision uuid,p_capability text,p_digest text,p_token uuid)
RETURNS SETOF public.project_backend_operations LANGUAGE plpgsql SET search_path='' AS $$
DECLARE permission public.project_automation_policies; existing public.project_backend_operations;
BEGIN
  SELECT * INTO permission FROM public.project_automation_policies WHERE id=p_policy AND user_id=p_owner AND project_id=p_project FOR UPDATE;
  IF NOT FOUND OR NOT permission.enabled OR permission.revision<>p_revision OR NOT p_capability=ANY(permission.capabilities) THEN RAISE EXCEPTION 'authorization changed'; END IF;
  PERFORM 1 FROM public.projects WHERE id=p_project AND user_id=p_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'project not owned'; END IF;
  SELECT * INTO existing FROM public.project_backend_operations WHERE id=p_id;
  IF FOUND THEN
    IF existing.user_id<>p_owner OR existing.project_id<>p_project OR existing.capability<>p_capability OR existing.input_digest<>p_digest THEN RAISE EXCEPTION 'idempotency key conflict'; END IF;
    IF existing.state IN ('queued','running','verifying') AND existing.lease_expires_at < now() THEN
      UPDATE public.project_backend_operations SET state='uncertain',message='Execução interrompida. Confira o resultado antes de repetir.',updated_at=now() WHERE id=p_id RETURNING * INTO existing;
    END IF;
    RETURN NEXT existing; RETURN;
  END IF;
  IF (SELECT count(*) FROM public.project_backend_operations WHERE policy_id=p_policy AND created_at>now()-interval '1 hour') >= permission.max_operations_per_hour THEN RAISE EXCEPTION 'hourly effect budget exceeded'; END IF;
  RETURN QUERY INSERT INTO public.project_backend_operations(id,user_id,project_id,policy_id,policy_revision,environment,capability,input_digest,state,claim_token,lease_expires_at,message)
    VALUES(p_id,p_owner,p_project,p_policy,p_revision,permission.environment,p_capability,p_digest,'queued',p_token,now()+interval '2 minutes','Operação registrada.') RETURNING *;
END $$;
REVOKE ALL ON FUNCTION public.claim_backend_operation(uuid,uuid,uuid,uuid,uuid,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_backend_operation(uuid,uuid,uuid,uuid,uuid,text,text,uuid) TO service_role;
