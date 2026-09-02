-- ============================================================
-- SUPREMO — Migration 015
--
-- Workflow v3: owner do repositório por projeto (pessoal vs organização).
--
-- Registra ONDE o repo do projeto é/será criado, decidido pela seleção segura de
-- owner (interseção: orgs a que o usuário tem acesso ∩ installations da GitHub App).
-- O provisioning lê isto para escolher o caminho:
--   github_owner_type = 'organization' → POST /orgs/{login}/repos com installation
--                       token da App na org (server-side, curto, não persistido);
--   github_owner_type = 'personal' (ou NULL) → POST /user/repos com o OAuth do
--                       usuário (fluxo atual, preservado).
--
--   github_owner_login = login do owner (ex.: 'ahmedhijazi94' ou 'Hijaziia').
--   github_owner_type  = 'personal' | 'organization'.
--
-- Nullable e SEM default: projeto existente fica NULL = PESSOAL (fail-safe; nunca
-- assume org). NÃO persiste token de instalação (resolvido on-demand no provisioning).
--
-- Idempotente. NÃO edita migrations já aplicadas. Só adiciona.
-- ============================================================

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS github_owner_login TEXT;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS github_owner_type TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_github_owner_type_check'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_github_owner_type_check
      CHECK (github_owner_type IS NULL OR github_owner_type IN ('personal', 'organization'));
  END IF;
END $$;
