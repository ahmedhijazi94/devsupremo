CREATE TABLE public.function_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  target_ref text NOT NULL,
  environment text NOT NULL CHECK(environment IN ('development','production')),
  slug text NOT NULL,
  version integer NOT NULL CHECK(version > 0),
  encrypted_bundle text NOT NULL,
  bundle_hash text NOT NULL CHECK(bundle_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,target_ref,environment,slug,version)
);
CREATE INDEX function_artifacts_user_idx ON public.function_artifacts(user_id);
ALTER TABLE public.function_artifacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.function_artifacts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.function_artifacts TO service_role;
CREATE TRIGGER function_artifacts_updated_at BEFORE UPDATE ON public.function_artifacts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
