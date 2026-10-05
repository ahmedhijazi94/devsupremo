-- Owner-approved provider destinations never originate in an agent's URL input.
CREATE TABLE public.provider_connections (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  credential_id uuid REFERENCES public.project_credentials(id) ON DELETE SET NULL,
  provider text NOT NULL CHECK (provider IN ('resend','stripe-test','github','generic')),
  environment text NOT NULL CHECK (environment IN ('development','production')),
  account_ref text NOT NULL,
  account_identity_verified boolean NOT NULL DEFAULT false,
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (provider <> 'stripe-test' OR environment = 'development')
);
CREATE INDEX provider_connections_user_idx ON public.provider_connections(user_id);
CREATE INDEX provider_connections_project_idx ON public.provider_connections(project_id, environment);
CREATE INDEX provider_connections_credential_idx ON public.provider_connections(credential_id);
ALTER TABLE public.provider_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.provider_connections FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_connections TO service_role;
CREATE TRIGGER provider_connections_updated_at BEFORE UPDATE ON public.provider_connections FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TABLE public.integration_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.provider_connections(id) ON DELETE CASCADE,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  claim_token uuid,
  claim_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_sessions_user_idx ON public.integration_sessions(user_id);
CREATE INDEX integration_sessions_project_idx ON public.integration_sessions(project_id, created_at);
CREATE INDEX integration_sessions_connection_idx ON public.integration_sessions(connection_id);
ALTER TABLE public.integration_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.integration_sessions TO service_role;
CREATE TRIGGER integration_sessions_updated_at BEFORE UPDATE ON public.integration_sessions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE FUNCTION public.claim_integration_session(p_id uuid, p_user_id uuid, p_project_id uuid, p_token uuid) RETURNS boolean
LANGUAGE sql SET search_path = '' AS $$
  WITH claimed AS (
    UPDATE public.integration_sessions s SET claim_token = p_token, claim_expires_at = now() + interval '2 minutes'
    WHERE s.id = p_id AND s.user_id = p_user_id AND s.project_id = p_project_id
      AND (s.claim_token IS NULL OR s.claim_expires_at < now())
      AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = s.project_id AND p.user_id = p_user_id)
      AND EXISTS (SELECT 1 FROM public.provider_connections c WHERE c.id = s.connection_id AND c.user_id = p_user_id
        AND c.project_id = p_project_id AND c.revoked_at IS NULL AND (c.credential_id IS NOT NULL OR c.scope->>'oauth'='true'))
    RETURNING id
  ) SELECT EXISTS(SELECT 1 FROM claimed);
$$;
REVOKE ALL ON FUNCTION public.claim_integration_session(uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_integration_session(uuid,uuid,uuid,uuid) TO service_role;
