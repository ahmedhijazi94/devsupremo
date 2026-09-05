-- Autoridade do control plane. Nunca inferir development para vínculos antigos.
CREATE TABLE public.project_database_environments (
  project_id uuid PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  project_ref text NOT NULL UNIQUE,
  environment text NOT NULL CHECK (environment IN ('development', 'production')),
  source text NOT NULL CHECK (source = 'supremo_provisioned'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.project_database_environments ENABLE ROW LEVEL SECURITY;
-- Sem policies para usuários: mesmo o dono não pode se autopromover a development.
REVOKE ALL ON public.project_database_environments FROM anon, authenticated;
GRANT ALL ON public.project_database_environments TO service_role;
CREATE TRIGGER project_database_environments_updated_at
  BEFORE UPDATE ON public.project_database_environments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
