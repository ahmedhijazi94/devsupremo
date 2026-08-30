-- ============================================================
-- SUPREMO — Migration 002
--
-- Idempotente: pode rodar mais de uma vez, e pode ser retomada se
-- falhar no meio. Nenhum comando destrói dado existente.
-- Tokens de MCP por usuário, store de OAuth state, e as colunas
-- que o loop prompt → branch → PR → gates → merge precisa.
-- ============================================================

-- ============================================================
-- MCP TOKENS — credencial por usuário para o MCP remoto
-- Substitui a chave global SUPREMO_API_KEY.
-- ============================================================
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  -- SHA-256 do token. O valor em claro nunca é persistido.
  token_hash TEXT NOT NULL UNIQUE,
  -- Primeiros caracteres, só para o usuário identificar o token na UI.
  token_prefix TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user_id ON mcp_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_hash ON mcp_tokens(token_hash)
  WHERE revoked_at IS NULL;

ALTER TABLE mcp_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mcp_tokens_owner_only" ON mcp_tokens;
CREATE POLICY "mcp_tokens_owner_only" ON mcp_tokens
  FOR ALL USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS mcp_tokens_updated_at ON mcp_tokens;
CREATE TRIGGER mcp_tokens_updated_at
  BEFORE UPDATE ON mcp_tokens
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- OAUTH STATES — store dedicado de CSRF state
-- Antes isso vivia em audit_logs, que é imutável por design e
-- não permite marcar o state como consumido (replay em 10 min).
-- ============================================================
CREATE TABLE IF NOT EXISTS oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  state TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'supabase')),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  redirect_to TEXT,
  consumed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_lookup
  ON oauth_states(state) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_states_user_id ON oauth_states(user_id);

ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "oauth_states_owner_only" ON oauth_states;
CREATE POLICY "oauth_states_owner_only" ON oauth_states
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- MESSAGES — colunas do loop de PR
-- ============================================================
ALTER TABLE messages ADD COLUMN IF NOT EXISTS branch TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pr_number INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pr_url TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS checks_url TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS preview_url TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_pr
  ON messages(project_id, pr_number) WHERE pr_number IS NOT NULL;

-- ============================================================
-- PROJECTS — credenciais e config do provisionamento
-- A senha do Postgres era gerada e descartada; agora é guardada
-- cifrada e o dono consegue recuperá-la.
-- ============================================================
ALTER TABLE projects ADD COLUMN IF NOT EXISTS db_password_encrypted TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS vercel_project_id TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS default_branch TEXT DEFAULT 'main' NOT NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS template_version TEXT;

-- ============================================================
-- AUDIT LOGS — endurecer a policy de INSERT
-- WITH CHECK (true) permitiria forjar registro em nome de outro.
-- ============================================================
DROP POLICY IF EXISTS "audit_logs_insert_own" ON audit_logs;
CREATE POLICY "audit_logs_insert_own" ON audit_logs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- LIMPEZA — states expirados não precisam ficar na tabela
-- ============================================================
CREATE OR REPLACE FUNCTION prune_expired_oauth_states()
RETURNS void AS $$
BEGIN
  DELETE FROM oauth_states
  WHERE expires_at < NOW() - INTERVAL '1 day';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- VERIFICAÇÃO — deve devolver 5 linhas, todas "ok"
-- ============================================================
SELECT 'tabela mcp_tokens' AS item,
       CASE WHEN to_regclass('public.mcp_tokens') IS NOT NULL
            THEN 'ok' ELSE 'FALTANDO' END AS status
UNION ALL
SELECT 'tabela oauth_states',
       CASE WHEN to_regclass('public.oauth_states') IS NOT NULL
            THEN 'ok' ELSE 'FALTANDO' END
UNION ALL
SELECT 'RLS em mcp_tokens',
       CASE WHEN (SELECT relrowsecurity FROM pg_class
                  WHERE oid = 'public.mcp_tokens'::regclass)
            THEN 'ok' ELSE 'FALTANDO' END
UNION ALL
SELECT 'colunas de PR em messages',
       CASE WHEN (SELECT count(*) FROM information_schema.columns
                  WHERE table_name = 'messages'
                    AND column_name IN ('branch','pr_number','pr_url',
                                        'checks_url','preview_url')) = 5
            THEN 'ok' ELSE 'FALTANDO' END
UNION ALL
SELECT 'colunas novas em projects',
       CASE WHEN (SELECT count(*) FROM information_schema.columns
                  WHERE table_name = 'projects'
                    AND column_name IN ('db_password_encrypted',
                                        'vercel_project_id',
                                        'default_branch','template_version')) = 4
            THEN 'ok' ELSE 'FALTANDO' END;
