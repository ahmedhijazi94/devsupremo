-- ============================================================
-- SUPREMO — Migration 014
--
-- Workflow v3: infraestrutura de integração assíncrona da `main`.
--
-- Registra, por projeto, COMO a main é integrada (capability detection) e o
-- nível REAL de proteção — para o Control Plane orquestrar auto-merge e para
-- observabilidade honesta (nunca afirmar proteção nativa que não existe).
--
--   github_merge_mode  = 'native' | 'supremo_managed'
--     native          → branch protection + required checks + auto-merge NATIVOS
--                       do GitHub cuidam do merge.
--     supremo_managed → GitHub Free privado (ou sem recurso nativo): o Merge
--                       Controller do Supremo valida os checks do HEAD exato e
--                       mescla via API.
--
--   protection_level   = 'github_native' | 'supremo_managed'
--     Espelha o nível efetivo de enforcement para diagnóstico/UI honesta.
--
--   integration_state  = estado do Control Plane (development, ci_running,
--     ci_failed, security_blocked, validated, merge_pending, merged,
--     unmanaged_main_change) — auditoria/reconciliação, NÃO polui a UX.
--
-- Nullable e SEM default: projeto existente fica NULL e é tratado com segurança
-- como "modo ainda não detectado" (o caminho gerenciado assume; nunca se presume
-- proteção nativa inexistente). A capacidade é (re)detectada no provisionamento e
-- em reconexões (seção 13), então pode migrar native <-> managed com segurança.
--
-- Idempotente. NÃO edita migrations já aplicadas. Só adiciona.
-- ============================================================

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS github_merge_mode TEXT;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS protection_level TEXT;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS integration_state TEXT;

-- Valores válidos, sem travar projetos antigos (NULL permitido).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_github_merge_mode_check'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_github_merge_mode_check
      CHECK (github_merge_mode IS NULL OR github_merge_mode IN ('native', 'supremo_managed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_protection_level_check'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_protection_level_check
      CHECK (protection_level IS NULL OR protection_level IN ('github_native', 'supremo_managed'));
  END IF;
END $$;
