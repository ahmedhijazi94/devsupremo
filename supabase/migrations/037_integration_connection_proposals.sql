CREATE TABLE public.integration_connection_proposals (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  input jsonb NOT NULL CHECK(jsonb_typeof(input)='object'),
  input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  connection_id uuid REFERENCES public.provider_connections(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  claim_token uuid,
  claim_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_connection_proposals_user_idx ON public.integration_connection_proposals(user_id);
CREATE INDEX integration_connection_proposals_project_idx ON public.integration_connection_proposals(project_id,status,expires_at);
CREATE INDEX integration_connection_proposals_connection_idx ON public.integration_connection_proposals(connection_id);
ALTER TABLE public.integration_connection_proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_connection_proposals FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.integration_connection_proposals TO service_role;
CREATE TRIGGER integration_connection_proposals_updated_at BEFORE UPDATE ON public.integration_connection_proposals FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
