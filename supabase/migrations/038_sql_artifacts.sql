CREATE TABLE public.project_sql_executors (
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES public.checkpoint_devices(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  ready boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,device_id)
);
CREATE INDEX project_sql_executors_device_idx ON public.project_sql_executors(device_id);
CREATE INDEX project_sql_executors_user_idx ON public.project_sql_executors(user_id);
ALTER TABLE public.project_sql_executors ENABLE ROW LEVEL SECURITY;
CREATE POLICY sql_executor_owner_read ON public.project_sql_executors FOR SELECT TO authenticated USING(user_id=(SELECT auth.uid()));
REVOKE ALL ON public.project_sql_executors FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.project_sql_executors TO authenticated;
GRANT ALL ON public.project_sql_executors TO service_role;

CREATE TABLE public.project_sql_artifacts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  project_ref text NOT NULL,
  account_id uuid,
  environment text NOT NULL DEFAULT 'development' CHECK(environment='development'),
  path text NOT NULL CHECK(path ~ '^supabase/migrations/[0-9]{14}_[a-f0-9]{32}\.sql$'),
  content text NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 250000),
  content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','materializing','materialized','applying','applied','succeeded','uncertain','failed','conflict')),
  device_id uuid REFERENCES public.checkpoint_devices(id) ON DELETE RESTRICT,
  claim_token uuid,
  session_id uuid,
  lease_expires_at timestamptz,
  message text NOT NULL,
  types_content text CHECK(octet_length(types_content)<=2000000),
  types_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,path)
);
CREATE INDEX project_sql_artifacts_owner_idx ON public.project_sql_artifacts(user_id);
CREATE INDEX project_sql_artifacts_project_idx ON public.project_sql_artifacts(project_id,state,created_at);
CREATE INDEX project_sql_artifacts_device_idx ON public.project_sql_artifacts(device_id);
ALTER TABLE public.project_sql_artifacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY sql_artifact_owner_read ON public.project_sql_artifacts FOR SELECT TO authenticated USING(user_id=(SELECT auth.uid()) AND EXISTS(SELECT 1 FROM public.projects p WHERE p.id=project_id AND p.user_id=(SELECT auth.uid())));
REVOKE ALL ON public.project_sql_artifacts FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.project_sql_artifacts TO authenticated;
GRANT ALL ON public.project_sql_artifacts TO service_role;

CREATE FUNCTION public.prepare_sql_artifact(p_id uuid,p_owner uuid,p_project uuid,p_ref text,p_account uuid,p_content text,p_digest text)
RETURNS SETOF public.project_sql_artifacts LANGUAGE plpgsql SET search_path='' AS $$
DECLARE next_version bigint;
BEGIN
  PERFORM 1 FROM public.projects WHERE id=p_project AND user_id=p_owner FOR UPDATE;
  IF NOT FOUND OR encode(sha256(convert_to(p_content,'UTF8')),'hex')<>p_digest THEN RAISE EXCEPTION 'invalid artifact authority or digest'; END IF;
  SELECT greatest(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYYMMDDHH24MISS')::bigint,coalesce(max(substring(path from 'migrations/([0-9]{14})')::bigint)+1,0)) INTO next_version FROM public.project_sql_artifacts WHERE project_id=p_project;
  RETURN QUERY INSERT INTO public.project_sql_artifacts(id,user_id,project_id,project_ref,account_id,path,content,content_digest,message)
    VALUES(p_id,p_owner,p_project,p_ref,p_account,'supabase/migrations/'||next_version||'_'||replace(p_id::text,'-','')||'.sql',p_content,p_digest,'Preparada; aguardando executor autorizado e gravação no histórico do projeto.') RETURNING *;
END $$;
REVOKE ALL ON FUNCTION public.prepare_sql_artifact(uuid,uuid,uuid,text,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_sql_artifact(uuid,uuid,uuid,text,uuid,text,text) TO service_role;

CREATE FUNCTION public.claim_sql_artifact(p_owner uuid,p_project uuid,p_device uuid,p_session uuid)
RETURNS SETOF public.project_sql_artifacts LANGUAGE plpgsql SET search_path='' AS $$
DECLARE chosen public.project_sql_artifacts;
BEGIN
  PERFORM 1 FROM public.projects p JOIN public.checkpoint_devices d ON d.owner_user_id=p.user_id WHERE p.id=p_project AND p.user_id=p_owner AND d.id=p_device AND d.revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid executor'; END IF;
  SELECT * INTO chosen FROM public.project_sql_artifacts WHERE user_id=p_owner AND project_id=p_project AND state IN ('prepared','materializing','materialized','applying','applied','uncertain')
    AND (state='prepared' OR (device_id=p_device AND (session_id=p_session OR lease_expires_at<now())) OR (state='materializing' AND lease_expires_at<now()))
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY UPDATE public.project_sql_artifacts SET device_id=p_device,session_id=p_session,
    claim_token=CASE WHEN chosen.session_id=p_session AND chosen.lease_expires_at>now() THEN chosen.claim_token ELSE gen_random_uuid() END,
    lease_expires_at=now()+interval '2 minutes',state=CASE WHEN chosen.state='prepared' THEN 'materializing' ELSE chosen.state END,updated_at=now()
    WHERE id=chosen.id RETURNING *;
END $$;
REVOKE ALL ON FUNCTION public.claim_sql_artifact(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_sql_artifact(uuid,uuid,uuid,uuid) TO service_role;
