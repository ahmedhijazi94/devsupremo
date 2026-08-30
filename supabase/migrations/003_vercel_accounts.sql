-- ============================================================
-- SUPREMO — Migration 003
--
-- Idempotente: pode rodar mais de uma vez, e pode ser retomada se
-- falhar no meio. Nenhum comando destrói dado existente.
--
-- Contas Vercel e o estado do preview por projeto. O preview em
-- navegador (WebContainer) foi substituído por deploy real: o do
-- navegador não sobrevive ao Next 16 e nunca gerou link compartilhável.
-- ============================================================

-- ============================================================
-- VERCEL ACCOUNTS
-- ============================================================
CREATE TABLE IF NOT EXISTS vercel_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  -- Nome do time ou da conta pessoal, para o usuário reconhecer na UI.
  account_name TEXT NOT NULL,
  -- team_xxx quando é time; nulo na conta pessoal.
  team_id TEXT,
  access_token_encrypted TEXT NOT NULL,  -- AES-256-GCM
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE(user_id, team_id)
);

CREATE INDEX IF NOT EXISTS idx_vercel_accounts_user_id
  ON vercel_accounts(user_id);

ALTER TABLE vercel_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vercel_accounts_owner_only" ON vercel_accounts;
CREATE POLICY "vercel_accounts_owner_only" ON vercel_accounts
  FOR ALL USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS vercel_accounts_updated_at ON vercel_accounts;
CREATE TRIGGER vercel_accounts_updated_at
  BEFORE UPDATE ON vercel_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- PROJECTS — vínculo com a Vercel
-- ============================================================
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS vercel_account_id UUID
  REFERENCES vercel_accounts(id) ON DELETE SET NULL;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS production_url TEXT;

CREATE INDEX IF NOT EXISTS idx_projects_vercel_account
  ON projects(vercel_account_id);

-- ============================================================
-- VERIFICAÇÃO — deve devolver 3 linhas, todas "ok"
-- ============================================================
SELECT 'tabela vercel_accounts' AS item,
       CASE WHEN to_regclass('public.vercel_accounts') IS NOT NULL
            THEN 'ok' ELSE 'FALTANDO' END AS status
UNION ALL
SELECT 'RLS em vercel_accounts',
       CASE WHEN (SELECT relrowsecurity FROM pg_class
                  WHERE oid = 'public.vercel_accounts'::regclass)
            THEN 'ok' ELSE 'FALTANDO' END
UNION ALL
SELECT 'colunas de Vercel em projects',
       CASE WHEN (SELECT count(*) FROM information_schema.columns
                  WHERE table_name = 'projects'
                    AND column_name IN ('vercel_account_id',
                                        'vercel_project_id',
                                        'production_url')) = 3
            THEN 'ok' ELSE 'FALTANDO' END;
