-- Reusable API credentials are encrypted by the control-plane server before storage.
-- Account password setup is deliberately excluded from this vault.
CREATE TABLE public.project_credentials (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development', 'preview', 'production')),
  encrypted_value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_credentials_private_name CHECK (
    name ~ '^[A-Z][A-Z0-9_]{0,127}$'
    AND name !~ '^(NEXT_PUBLIC_|PUBLIC_|VITE_|REACT_APP_|NUXT_PUBLIC_|AUTH_USER_PASSWORD_)'
    AND name !~ '^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|PATH|HOME|SHELL)$'
  ),
  CONSTRAINT project_credentials_encrypted_envelope CHECK (
    char_length(encrypted_value) BETWEEN 63 AND 32829
    AND char_length(encrypted_value) % 2 = 1
    AND encrypted_value ~ '^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$'
  )
);

CREATE INDEX idx_project_credentials_user_id ON public.project_credentials(user_id);
CREATE INDEX idx_project_credentials_project_id ON public.project_credentials(project_id);
CREATE INDEX idx_project_credentials_scope ON public.project_credentials(project_id, environment, name);

ALTER TABLE public.project_credentials ENABLE ROW LEVEL SECURITY;
-- No browser policies: even the owner must use authorized server operations.
REVOKE ALL ON TABLE public.project_credentials FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.project_credentials TO service_role;

CREATE TRIGGER project_credentials_updated_at
  BEFORE UPDATE ON public.project_credentials
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

COMMENT ON TABLE public.project_credentials IS
  'Server-only project credential vault. Every operation must authorize owner, project and environment before accessing ciphertext.';
COMMENT ON COLUMN public.project_credentials.encrypted_value IS
  'Versioned AES-256-GCM ciphertext authenticated to id, user_id, project_id and environment. No plaintext or decryption key is stored here.';
