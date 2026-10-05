-- OAuth client IDs are public setup intent. Client secrets remain in the owner
-- form or encrypted project vault, never in request metadata or audit payloads.
ALTER TABLE public.secret_requests
  DROP CONSTRAINT secret_requests_configuration,
  ADD CONSTRAINT secret_requests_configuration
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
      OR (
        configuration->>'kind' = 'supabase-auth-provider'
        AND environment IN ('development', 'production')
        AND configuration->>'provider' IN ('google', 'github')
        AND configuration ?& ARRAY['kind', 'provider', 'clientId']
        AND configuration - ARRAY['kind', 'provider', 'clientId']::text[] = '{}'::jsonb
        AND jsonb_typeof(configuration->'clientId') = 'string'
        AND char_length(configuration->>'clientId') BETWEEN 1 AND 512
        AND configuration->>'clientId' ~ '^[A-Za-z0-9._-]+$'
      )
    )
  ) IS TRUE);

COMMENT ON COLUMN public.secret_requests.configuration IS
  'Allowlisted setup metadata, including public OAuth client IDs. Never store API keys, client secrets, passwords, or recovery codes here.';
