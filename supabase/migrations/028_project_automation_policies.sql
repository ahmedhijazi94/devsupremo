-- Only owner-authenticated server actions may grant authority. Device requests
-- cannot write this table. Revocation is a new revision, never a cached grant.
CREATE TABLE public.project_automation_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('development', 'production')),
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  enabled boolean NOT NULL DEFAULT false,
  capabilities text[] NOT NULL DEFAULT '{}',
  resources text[] NOT NULL DEFAULT '{}',
  device_ids uuid[] NOT NULL DEFAULT '{}',
  max_rows integer NOT NULL DEFAULT 25 CHECK (max_rows BETWEEN 1 AND 1000),
  max_operations_per_hour integer NOT NULL DEFAULT 60 CHECK (max_operations_per_hour BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, environment)
);
CREATE INDEX project_automation_policies_user_idx ON public.project_automation_policies(user_id);
ALTER TABLE public.project_automation_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_automation_policies_owner_read ON public.project_automation_policies FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND p.user_id = (SELECT auth.uid())));
REVOKE ALL ON public.project_automation_policies FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.project_automation_policies TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_automation_policies TO service_role;

-- CAS writes and audit are one transaction. Identity is checked by the owner
-- session adapter before calling this service-only function.
CREATE FUNCTION public.save_project_automation_policy(p_owner uuid, p_project uuid, p_environment text, p_expected uuid, p_settings jsonb)
RETURNS uuid LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE previous public.project_automation_policies; next_revision uuid := gen_random_uuid();
BEGIN
  PERFORM 1 FROM public.projects WHERE id = p_project AND user_id = p_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project not owned'; END IF;
  SELECT * INTO previous FROM public.project_automation_policies WHERE project_id = p_project AND environment = p_environment FOR UPDATE;
  IF (FOUND AND previous.revision IS DISTINCT FROM p_expected) OR (NOT FOUND AND p_expected IS NOT NULL) THEN RAISE EXCEPTION 'policy revision changed'; END IF;
  INSERT INTO public.project_automation_policies(user_id,project_id,environment,revision,enabled,capabilities,resources,device_ids,max_rows,max_operations_per_hour)
  VALUES(p_owner,p_project,p_environment,next_revision,(p_settings->>'enabled')::boolean,
    ARRAY(SELECT jsonb_array_elements_text(p_settings->'capabilities')),
    ARRAY(SELECT jsonb_array_elements_text(p_settings->'resources')),
    ARRAY(SELECT jsonb_array_elements_text(p_settings->'deviceIds')::uuid),
    (p_settings->>'maxRows')::integer,(p_settings->>'maxOperationsPerHour')::integer)
  ON CONFLICT(project_id,environment) DO UPDATE SET revision=next_revision, enabled=EXCLUDED.enabled,
    capabilities=EXCLUDED.capabilities,resources=EXCLUDED.resources,device_ids=EXCLUDED.device_ids,
    max_rows=EXCLUDED.max_rows,max_operations_per_hour=EXCLUDED.max_operations_per_hour,updated_at=now();
  INSERT INTO public.audit_logs(user_id,action,resource_type,resource_id,metadata)
    VALUES(p_owner,'automation.policy.saved','project',p_project,jsonb_build_object('environment',p_environment,'revision',next_revision,'enabled',p_settings->'enabled','capabilities',p_settings->'capabilities'));
  RETURN next_revision;
END $$;
REVOKE ALL ON FUNCTION public.save_project_automation_policy(uuid,uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_project_automation_policy(uuid,uuid,text,uuid,jsonb) TO service_role;
