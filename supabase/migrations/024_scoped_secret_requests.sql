-- Metadata only: values are submitted directly to the explicitly bound provider.
-- Legacy rows remain visible but unfillable until a new request pins a destination.
ALTER TABLE public.secret_requests
  ADD COLUMN target text CHECK (target IN ('supabase', 'vercel')),
  ADD COLUMN environment text CHECK (environment IN ('development', 'preview', 'production')),
  ADD COLUMN target_ref text,
  ADD COLUMN target_account_id uuid,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.secret_requests DROP CONSTRAINT secret_requests_project_id_name_key;
ALTER TABLE public.secret_requests ADD CONSTRAINT secret_requests_destination_key
  UNIQUE (project_id, name, target, environment, target_ref, target_account_id);
ALTER TABLE public.secret_requests ADD CONSTRAINT secret_requests_bound_destination
  CHECK ((target IS NULL AND environment IS NULL AND target_ref IS NULL AND target_account_id IS NULL)
    OR (target IS NOT NULL AND environment IS NOT NULL AND target_ref IS NOT NULL AND target_ref ~ '^[A-Za-z0-9_-]{1,128}$' AND target_account_id IS NOT NULL
      AND is_secret AND name ~ '^[A-Z][A-Z0-9_]{0,127}$'
      AND name !~ '^(NEXT_PUBLIC_|PUBLIC_|VITE_|REACT_APP_|NUXT_PUBLIC_)'
      AND (target <> 'supabase' OR (environment <> 'preview' AND name !~ '^SUPABASE_'))));

-- Metadata is evidence: browser clients cannot forge a delivered status or retarget
-- a field whose owner has already started typing. Device registration and delivery
-- confirmation use the owner-checked backend service role, never the public data API.
REVOKE INSERT, UPDATE ON public.secret_requests FROM PUBLIC, anon, authenticated;
DROP POLICY "secret_requests_owner" ON public.secret_requests;
CREATE POLICY "secret_requests_owner_read" ON public.secret_requests FOR SELECT TO authenticated
  USING (auth.uid() = user_id AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND p.user_id = auth.uid()));
CREATE POLICY "secret_requests_owner_dismiss" ON public.secret_requests FOR DELETE TO authenticated
  USING (auth.uid() = user_id AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND p.user_id = auth.uid()));
-- target_account_id is polymorphic (Supabase or Vercel), resolved by owner+target at every request/save.
CREATE INDEX idx_secret_requests_target_account ON public.secret_requests(target_account_id);
