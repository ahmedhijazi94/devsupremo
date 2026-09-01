-- ============================================================
-- SUPREMO — Migration 013
--
-- Arquitetura v2: "Supremo provisiona, a máquina local desenvolve".
--
-- Adiciona ao projeto a máquina de estados de provisioning (retomável e
-- idempotente), as capabilities habilitadas (CORE + capabilities), o perfil de
-- segurança inferido e as versões de scaffold/baseline. Cria também a tabela de
-- códigos de bootstrap: concessões one-time, curtas e com escopo projeto+dono
-- que autorizam a máquina local a receber a config (.env.local) — SEM secret no
-- Git, no shell ou em log.
--
-- Idempotente. NÃO edita migrations já aplicadas. Só adiciona.
-- ============================================================

-- ── 1. Máquina de estados de provisioning ──────────────────────────────────
-- DOIS EIXOS INDEPENDENTES, sem duas fontes de verdade:
--   • status              = lifecycle FUNCIONAL do projeto (active/archived).
--   • provisioning_state  = SÓ o provisioning (draft→…→ready|failed).
-- Um projeto pode estar status=archived E provisioning_state=ready sem conflito.
-- O `status` legado continua existindo; daqui pra frente o código escreve
-- estados de criação/erro em provisioning_state, e mantém status em
-- active/archived. Não reescrevemos o status legado (evita suposição sobre
-- linhas antigas) — só semeamos provisioning_state uma vez.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS provisioning_state TEXT;

-- Backfill (uma vez): deriva o provisioning_state inicial do status legado.
-- É só semeadura; depois os dois eixos evoluem independentes.
UPDATE projects
SET provisioning_state = CASE
    WHEN status = 'active'   THEN 'ready'
    WHEN status = 'error'    THEN 'failed'
    WHEN status = 'creating' THEN 'provisioning'
    WHEN status = 'archived' THEN 'ready'
    ELSE 'draft'
  END
WHERE provisioning_state IS NULL;

ALTER TABLE projects
  ALTER COLUMN provisioning_state SET DEFAULT 'draft';

-- Garante NOT NULL só depois do backfill (evita quebrar se algo escapou).
UPDATE projects SET provisioning_state = 'draft' WHERE provisioning_state IS NULL;
ALTER TABLE projects
  ALTER COLUMN provisioning_state SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_provisioning_state_check'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_provisioning_state_check
      CHECK (provisioning_state IN (
        'draft', 'provisioning', 'scaffolding', 'validating', 'ready', 'failed'
      ));
  END IF;
END $$;

-- Documenta a semântica dos dois eixos no próprio banco (durável, idempotente).
COMMENT ON COLUMN projects.status IS
  'Lifecycle funcional do projeto (active/archived). NÃO é estado de provisioning.';
COMMENT ON COLUMN projects.provisioning_state IS
  'Estado do provisioning: draft→provisioning→scaffolding→validating→ready|failed. Independente de status.';

-- Passos persistidos pra retomar de onde parou (idempotência do pipeline).
-- Ex.: {"github":"done","supabase":"done","scaffold":"pending"}.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS provisioning_steps JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Última mensagem de erro do provisioning (não sensível), pra UI e retry.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS provisioning_error TEXT;

-- ── 2. CORE + capabilities ─────────────────────────────────────────────────
-- Capabilities habilitadas, como metadata NÃO sensível. Ex.: ["auth","storage"].
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Perfil de segurança inferido PRINCIPALMENTE pelas capabilities/arquitetura
-- real (o `kind` é só um sinal, não sinônimo). Define a intensidade dos checks;
-- nunca reduz o baseline.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS security_profile TEXT;
COMMENT ON COLUMN projects.security_profile IS
  'Perfil inferido das capabilities (simple/standard/multitenant/sensitive). kind é apenas um sinal, não a fonte.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_security_profile_check'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_security_profile_check
      CHECK (security_profile IS NULL OR security_profile IN (
        'simple', 'standard', 'multitenant', 'sensitive'
      ));
  END IF;
END $$;

-- Versionamento explícito do scaffold e do baseline de segurança.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS scaffold_version TEXT;
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS security_baseline_version TEXT;

-- ── 3. Bootstrap por DEVICE FLOW (RFC 8628) ────────────────────────────────
-- O comando local é `supremo bootstrap <project-id>` (project-id NÃO é segredo).
-- O CLI abre um device flow: recebe um device_code (segredo do CLI, só hash no
-- banco) e mostra um user_code curto; o DONO autoriza no browser (autenticado),
-- e só então o CLI troca por config. Assim nenhum segredo temporário vai ao
-- shell history.
--
--   device_code_hash  SHA-256 do device_code (segredo com que o CLI faz poll)
--   user_code         código curto que liga CLI ↔ browser (não é segredo forte)
--   user_id           NULL até o dono aprovar (aí vira auth.uid() do dono)
--   status            pending → approved → consumed | denied
--
-- RLS owner-only protege listar/revogar pelo dashboard. Linhas pending têm
-- user_id NULL → invisíveis a qualquer client; todo o fluxo (criar/aprovar/
-- consumir) roda server-side com service_role e checagem de dono explícita.
CREATE TABLE IF NOT EXISTS bootstrap_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,  -- NULL até aprovar
  device_code_hash TEXT NOT NULL,   -- SHA-256 do device_code (nunca o valor)
  user_code TEXT NOT NULL,          -- curto, mostrado no browser
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'consumed', 'denied')),
  approved_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,  -- curto prazo (ex.: 15 min)
  created_ip TEXT,                  -- auditoria (não sensível)
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bootstrap_codes_device ON bootstrap_codes(device_code_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bootstrap_codes_usercode ON bootstrap_codes(user_code);
CREATE INDEX IF NOT EXISTS idx_bootstrap_codes_project ON bootstrap_codes(project_id);
CREATE INDEX IF NOT EXISTS idx_bootstrap_codes_user ON bootstrap_codes(user_id);

ALTER TABLE bootstrap_codes ENABLE ROW LEVEL SECURITY;

-- Dono vê/gerencia só os seus (pending com user_id NULL ficam invisíveis a
-- clients — só o servidor os toca). Nunca confia em user_id do client.
DROP POLICY IF EXISTS "bootstrap_codes_owner_only" ON bootstrap_codes;
CREATE POLICY "bootstrap_codes_owner_only" ON bootstrap_codes
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- VERIFICAÇÃO — deve devolver 1 linha "ok"
-- ============================================================
SELECT 'scaffold v2 + bootstrap' AS item,
       CASE WHEN
            (SELECT count(*) FROM information_schema.columns
              WHERE table_name = 'projects'
                AND column_name IN (
                  'provisioning_state','provisioning_steps','provisioning_error',
                  'capabilities','security_profile','scaffold_version',
                  'security_baseline_version'
                )) = 7
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_provisioning_state_check')
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_security_profile_check')
        AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'bootstrap_codes')
        AND (SELECT count(*) FROM information_schema.columns
              WHERE table_name = 'bootstrap_codes'
                AND column_name IN ('device_code_hash','user_code','status','approved_at')) = 4
        AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bootstrap_codes'
                     AND policyname = 'bootstrap_codes_owner_only')
            THEN 'ok' ELSE 'FALTANDO' END AS status;
