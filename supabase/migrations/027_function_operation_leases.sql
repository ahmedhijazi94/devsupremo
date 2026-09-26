-- Serializes deployment and email-hook changes for a trusted provider project.
-- One provider ref has one lease, including requests from different server instances.
CREATE TABLE public.function_operation_leases (
  target_ref text PRIMARY KEY CHECK (target_ref ~ '^[a-z0-9_-]{1,64}$'),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('development', 'production')),
  claim_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_function_operation_leases_project ON public.function_operation_leases(project_id);
CREATE INDEX idx_function_operation_leases_user ON public.function_operation_leases(user_id);
ALTER TABLE public.function_operation_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.function_operation_leases FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.function_operation_leases TO service_role;
CREATE TRIGGER function_operation_leases_updated_at BEFORE UPDATE ON public.function_operation_leases
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE FUNCTION public.claim_function_operation(
  p_project_id uuid, p_user_id uuid, p_target_ref text, p_environment text, p_claim_token uuid
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE expiry timestamptz;
BEGIN
  IF p_claim_token IS NULL OR p_target_ref IS NULL OR p_target_ref !~ '^[a-z0-9_-]{1,64}$'
    OR p_environment IS NULL OR p_environment NOT IN ('development','production') THEN RETURN NULL; END IF;
  -- Server-owned environment provenance and account ownership are checked inside
  -- the same transaction that creates/reclaims the lease.
  PERFORM p.id FROM public.projects p
    JOIN public.project_database_environments e ON e.project_id=p.id
    JOIN public.supabase_accounts a ON a.id=p.supabase_account_id AND a.user_id=p.user_id
    WHERE p.id=p_project_id AND p.user_id=p_user_id AND p.supabase_project_ref=p_target_ref
      AND e.project_ref=p_target_ref AND e.environment=p_environment AND e.source='supremo_provisioned'
    FOR UPDATE OF p,e;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO public.function_operation_leases(target_ref,project_id,user_id,environment,claim_token,lease_expires_at)
    VALUES(p_target_ref,p_project_id,p_user_id,p_environment,p_claim_token,clock_timestamp()+interval '2 minutes')
    ON CONFLICT(target_ref) DO UPDATE SET project_id=excluded.project_id,user_id=excluded.user_id,
      environment=excluded.environment,claim_token=excluded.claim_token,lease_expires_at=excluded.lease_expires_at
    WHERE function_operation_leases.lease_expires_at<=clock_timestamp()
    RETURNING lease_expires_at INTO expiry;
  RETURN expiry;
END; $$;

CREATE FUNCTION public.verify_function_operation(
  p_project_id uuid, p_user_id uuid, p_target_ref text, p_environment text, p_claim_token uuid
) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS(SELECT 1 FROM public.function_operation_leases l
    JOIN public.projects p ON p.id=l.project_id AND p.user_id=l.user_id
    JOIN public.project_database_environments e ON e.project_id=p.id
    JOIN public.supabase_accounts a ON a.id=p.supabase_account_id AND a.user_id=p.user_id
    WHERE l.project_id=p_project_id AND l.user_id=p_user_id AND l.target_ref=p_target_ref
      AND l.environment=p_environment AND l.claim_token=p_claim_token
      AND p.supabase_project_ref=l.target_ref AND e.project_ref=l.target_ref
      AND e.environment=l.environment AND e.source='supremo_provisioned'
      -- Greater than the largest (40 s) provider timeout before every dispatch.
      AND l.lease_expires_at>clock_timestamp()+interval '45 seconds');
$$;
REVOKE ALL ON FUNCTION public.claim_function_operation(uuid,uuid,text,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.verify_function_operation(uuid,uuid,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_function_operation(uuid,uuid,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_function_operation(uuid,uuid,text,text,uuid) TO service_role;
COMMENT ON TABLE public.function_operation_leases IS
  'Server-only short lease. Failures retain the lease until expiry; successful release compares project, owner, ref and claim token.';
