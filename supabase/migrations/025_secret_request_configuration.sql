-- Configuration intent only. Credentials/passwords are never persisted by Supremo.
-- Owner scope and server-only writes remain; live delivery claims also block dismissal.
ALTER TABLE public.secret_requests
  ADD COLUMN configuration jsonb,
  ADD COLUMN delivery_claim_id uuid,
  ADD COLUMN delivery_claim_expires_at timestamptz;

ALTER TABLE public.secret_requests ADD CONSTRAINT secret_requests_delivery_claim
  CHECK ((delivery_claim_id IS NULL AND delivery_claim_expires_at IS NULL)
    OR (delivery_claim_id IS NOT NULL AND delivery_claim_expires_at IS NOT NULL AND status = 'pending'));

DROP POLICY "secret_requests_owner_dismiss" ON public.secret_requests;
CREATE POLICY "secret_requests_owner_dismiss" ON public.secret_requests FOR DELETE TO authenticated
  USING (auth.uid() = user_id
    AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND p.user_id = auth.uid())
    AND (delivery_claim_id IS NULL OR delivery_claim_expires_at <= now()));

ALTER TABLE public.secret_requests ADD CONSTRAINT secret_requests_configuration
  CHECK (configuration IS NULL OR (
    target = 'supabase'
    AND jsonb_typeof(configuration) = 'object'
    AND (
      (
        configuration->>'kind' = 'supabase-smtp'
        AND environment IN ('development', 'production')
        AND configuration->>'provider' = 'resend'
        AND configuration ?& ARRAY['kind', 'provider', 'senderEmail', 'senderName']
        AND configuration - ARRAY['kind', 'provider', 'senderEmail', 'senderName']::text[] = '{}'::jsonb
        AND jsonb_typeof(configuration->'senderEmail') = 'string'
        AND char_length(configuration->>'senderEmail') BETWEEN 3 AND 254
        AND configuration->>'senderEmail' ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
        AND jsonb_typeof(configuration->'senderName') = 'string'
        AND char_length(btrim(configuration->>'senderName')) BETWEEN 1 AND 100
        AND char_length(configuration->>'senderName') <= 100
        AND configuration->>'senderName' !~ E'[\r\n]'
      )
      OR (
        configuration->>'kind' = 'supabase-user-password'
        AND environment = 'development'
        AND configuration ?& ARRAY['kind', 'userId']
        AND configuration - ARRAY['kind', 'userId']::text[] = '{}'::jsonb
        AND jsonb_typeof(configuration->'userId') = 'string'
        AND configuration->>'userId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      )
    )
  ) IS TRUE);

COMMENT ON COLUMN public.secret_requests.configuration IS
  'Allowlisted setup metadata. Never store an API key, SMTP password, account password, or recovery code here.';
COMMENT ON COLUMN public.secret_requests.delivery_claim_id IS
  'Server-only reservation identifier, not a credential. Compare-and-set prevents concurrent secret saves.';
COMMENT ON COLUMN public.secret_requests.delivery_claim_expires_at IS
  'Short server delivery lease. Expiry permits recovery after a worker exits; active leases prohibit dismissal.';
