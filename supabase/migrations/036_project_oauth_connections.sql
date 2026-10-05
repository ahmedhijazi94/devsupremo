-- OAuth codes and rotating refresh tokens are consumed once, never retried after
-- a lost response. Only server adapters may access encrypted protocol material.
CREATE TABLE public.project_oauth_states (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('development','production')),
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  redirect_uri text NOT NULL,
  verifier_cipher text NOT NULL,
  policy_id uuid NOT NULL REFERENCES public.project_automation_policies(id) ON DELETE RESTRICT,
  policy_revision uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','exchanging','completed','uncertain')),
  claim_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_oauth_states_owner_idx ON public.project_oauth_states(user_id);
CREATE INDEX project_oauth_states_project_idx ON public.project_oauth_states(project_id,expires_at);
CREATE INDEX project_oauth_states_policy_idx ON public.project_oauth_states(policy_id);
ALTER TABLE public.project_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_oauth_states FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.project_oauth_states TO service_role;
CREATE TRIGGER project_oauth_states_updated_at BEFORE UPDATE ON public.project_oauth_states FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TABLE public.project_oauth_credentials (
  connection_id uuid PRIMARY KEY REFERENCES public.provider_connections(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('development','production')),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  token_cipher text NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','refreshing','uncertain','revoked')),
  claim_token uuid,
  claim_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_oauth_credentials_owner_idx ON public.project_oauth_credentials(user_id);
CREATE INDEX project_oauth_credentials_project_idx ON public.project_oauth_credentials(project_id,environment);
ALTER TABLE public.project_oauth_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_oauth_credentials FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.project_oauth_credentials TO service_role;
CREATE TRIGGER project_oauth_credentials_updated_at BEFORE UPDATE ON public.project_oauth_credentials FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE FUNCTION public.claim_project_oauth_state(p_hash text,p_owner uuid,p_project uuid,p_claim uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE v_state public.project_oauth_states;
BEGIN
  UPDATE public.project_oauth_states s SET status='exchanging',claim_token=p_claim
    WHERE s.state_hash=p_hash AND s.user_id=p_owner AND s.project_id=p_project AND s.status='pending' AND s.expires_at>now()
    AND EXISTS(SELECT 1 FROM public.projects p WHERE p.id=s.project_id AND p.user_id=p_owner)
    RETURNING s.* INTO v_state;
  RETURN CASE WHEN v_state.id IS NULL THEN NULL ELSE to_jsonb(v_state) END;
END $$;

CREATE FUNCTION public.finish_project_oauth_state(p_id uuid,p_owner uuid,p_project uuid,p_claim uuid,p_cipher text) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE s public.project_oauth_states;
BEGIN
  SELECT * INTO s FROM public.project_oauth_states WHERE id=p_id AND user_id=p_owner AND project_id=p_project FOR UPDATE;
  IF s.id IS NULL OR s.status<>'exchanging' OR s.claim_token IS DISTINCT FROM p_claim OR s.expires_at<=now()
    OR NOT EXISTS(SELECT 1 FROM public.projects p WHERE p.id=p_project AND p.user_id=p_owner)
    OR NOT EXISTS(SELECT 1 FROM public.project_automation_policies p WHERE p.id=s.policy_id AND p.revision=s.policy_revision AND p.enabled AND p.user_id=p_owner AND p.project_id=p_project AND p.environment=s.environment)
    THEN RAISE EXCEPTION 'OAuth authorization changed'; END IF;
  INSERT INTO public.provider_connections(id,user_id,project_id,provider,environment,account_ref,account_identity_verified,scope)
    VALUES(s.id,p_owner,p_project,'generic',s.environment,s.config->'connector'->'identity'->>'account',true,jsonb_build_object('contract',s.config->'connector','oauth',true));
  INSERT INTO public.project_oauth_credentials(connection_id,user_id,project_id,environment,config,token_cipher)
    VALUES(s.id,p_owner,p_project,s.environment,s.config,p_cipher);
  UPDATE public.project_oauth_states SET status='completed',verifier_cipher='' WHERE id=p_id;
  INSERT INTO public.audit_logs(user_id,resource_type,resource_id,action,metadata,ip_address)
    VALUES(p_owner,'project',p_project,'integration.oauth_connected',jsonb_build_object('connectionId',p_id,'provider',s.config->>'providerKey','environment',s.environment),NULL);
  RETURN true;
END $$;

CREATE FUNCTION public.claim_project_oauth_refresh(p_id uuid,p_owner uuid,p_project uuid,p_version bigint,p_claim uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE c public.project_oauth_credentials;
BEGIN
  SELECT * INTO c FROM public.project_oauth_credentials WHERE connection_id=p_id AND user_id=p_owner AND project_id=p_project FOR UPDATE;
  IF c.connection_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.provider_connections x JOIN public.projects p ON p.id=x.project_id
    WHERE x.id=p_id AND x.user_id=p_owner AND x.project_id=p_project AND x.revoked_at IS NULL AND p.user_id=p_owner) THEN RETURN false; END IF;
  IF c.status='refreshing' AND c.claim_expires_at<=now() THEN
    UPDATE public.project_oauth_credentials SET status='uncertain' WHERE connection_id=p_id;
    RETURN false;
  END IF;
  IF c.status<>'active' OR c.version<>p_version THEN RETURN false; END IF;
  UPDATE public.project_oauth_credentials SET status='refreshing',claim_token=p_claim,claim_expires_at=now()+interval '2 minutes' WHERE connection_id=p_id;
  RETURN true;
END $$;

CREATE FUNCTION public.finish_project_oauth_refresh(p_id uuid,p_owner uuid,p_project uuid,p_version bigint,p_claim uuid,p_cipher text) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  UPDATE public.project_oauth_credentials c SET token_cipher=p_cipher,version=c.version+1,status='active',claim_token=NULL,claim_expires_at=NULL
    WHERE c.connection_id=p_id AND c.user_id=p_owner AND c.project_id=p_project AND c.version=p_version AND c.status='refreshing'
    AND c.claim_token=p_claim AND c.claim_expires_at>now()
    AND EXISTS(SELECT 1 FROM public.provider_connections x JOIN public.projects p ON p.id=x.project_id
      WHERE x.id=p_id AND x.user_id=p_owner AND x.project_id=p_project AND x.revoked_at IS NULL AND p.user_id=p_owner);
  IF NOT FOUND THEN RAISE EXCEPTION 'OAuth refresh ownership or revision changed'; END IF;
  RETURN true;
END $$;

CREATE FUNCTION public.revoke_project_oauth_connection(p_id uuid,p_owner uuid,p_project uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  UPDATE public.provider_connections c SET revoked_at=COALESCE(c.revoked_at,now()) WHERE c.id=p_id AND c.user_id=p_owner AND c.project_id=p_project
    AND EXISTS(SELECT 1 FROM public.projects p WHERE p.id=p_project AND p.user_id=p_owner);
  IF NOT FOUND THEN RAISE EXCEPTION 'OAuth connection not owned'; END IF;
  UPDATE public.project_oauth_credentials SET status='revoked',token_cipher='',claim_token=NULL,claim_expires_at=NULL
    WHERE connection_id=p_id AND user_id=p_owner AND project_id=p_project;
  IF NOT FOUND THEN RAISE EXCEPTION 'OAuth connection unavailable'; END IF;
  INSERT INTO public.audit_logs(user_id,resource_type,resource_id,action,metadata,ip_address)
    VALUES(p_owner,'project',p_project,'integration.oauth_revoked',jsonb_build_object('connectionId',p_id),NULL);
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.claim_project_oauth_state(text,uuid,uuid,uuid),public.finish_project_oauth_state(uuid,uuid,uuid,uuid,text),public.claim_project_oauth_refresh(uuid,uuid,uuid,bigint,uuid),public.finish_project_oauth_refresh(uuid,uuid,uuid,bigint,uuid,text),public.revoke_project_oauth_connection(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_project_oauth_state(text,uuid,uuid,uuid),public.finish_project_oauth_state(uuid,uuid,uuid,uuid,text),public.claim_project_oauth_refresh(uuid,uuid,uuid,bigint,uuid),public.finish_project_oauth_refresh(uuid,uuid,uuid,bigint,uuid,text),public.revoke_project_oauth_connection(uuid,uuid,uuid) TO service_role;
