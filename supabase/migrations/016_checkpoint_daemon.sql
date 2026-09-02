-- ============================================================
-- SUPREMO — Migration 016
--
-- Workflow v3.1 (item 4): checkpoint/push SILENCIOSO.
--
-- O agente termina cada pedido com um CHECKPOINT LOCAL (commit). Um daemon local
-- envia o checkpoint em background, autenticado por uma IDENTIDADE DE MÁQUINA que
-- o usuário autoriza UMA vez (device flow existente). O backend emite, sob
-- demanda, um installation token da GitHub App escopado ao repo do projeto e o
-- descarta após o push. Nada disso pede autorização por turno.
--
-- Esta migration adiciona:
--   1. checkpoint_devices — identidade revogável da máquina (só o HASH do secret);
--   2. checkpoints        — metadata de cada checkpoint (base do "voltar para
--                           antes da mensagem N");
--   3. projects.github_repo_id — id numérico do repo (backfill p/ token por id).
--
-- Idempotente. NÃO edita migrations já aplicadas. Só adiciona.
-- ============================================================

-- ── 1. Identidade da máquina (checkpoint daemon) ────────────────────────────
-- O daemon guarda o SECRET no keychain do SO (nunca no projeto). O banco guarda
-- só o SHA-256. Revogável pelo dono (revoked_at). Um vazamento do banco não dá
-- nenhum secret utilizável.
CREATE TABLE IF NOT EXISTS checkpoint_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  -- SHA-256 (hex) do device secret. NUNCA o valor. Único global.
  secret_hash TEXT NOT NULL UNIQUE,
  device_label TEXT,
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkpoint_devices_owner ON checkpoint_devices (owner_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkpoint_devices_secret ON checkpoint_devices (secret_hash);

ALTER TABLE checkpoint_devices ENABLE ROW LEVEL SECURITY;

-- Só o DONO vê/revoga seus devices. A checagem do secret (autenticar o daemon)
-- roda server-side com service_role; o client nunca precisa ler o hash.
DROP POLICY IF EXISTS "checkpoint_devices_owner" ON checkpoint_devices;
CREATE POLICY "checkpoint_devices_owner" ON checkpoint_devices
  FOR ALL
  USING (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

-- ── 2. Checkpoints ──────────────────────────────────────────────────────────
-- Um checkpoint por pedido funcional. Guarda o SHA local, o pai (para reconstruir
-- a linha do tempo e "voltar para antes da mensagem N"), risco, migrations
-- envolvidas e o estado de push/integração. NUNCA agrupa pedidos arbitrariamente.
CREATE TABLE IF NOT EXISTS checkpoints (
  -- checkpoint_id gerado no CLI (uuid); é a chave estável usada pelo daemon.
  id UUID PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  device_id UUID REFERENCES checkpoint_devices(id) ON DELETE SET NULL,
  -- SHA do commit local do checkpoint.
  commit_sha TEXT NOT NULL,
  parent_checkpoint_id UUID REFERENCES checkpoints(id) ON DELETE SET NULL,
  summary TEXT NOT NULL,
  risk_level TEXT NOT NULL DEFAULT 'low'
    CHECK (risk_level IN ('low', 'medium', 'high')),
  -- Migrations tocadas por este checkpoint (paths), para o modelo de restore.
  migrations JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Estado do envio: local → pushing → pushed → integrated | push_failed.
  push_status TEXT NOT NULL DEFAULT 'local'
    CHECK (push_status IN ('local', 'pushing', 'pushed', 'integrated', 'push_failed')),
  -- Estado de CI/merge (reusa a semântica da v3; preenchido server-side).
  integration_status TEXT,
  -- PR aberta para este checkpoint (quando já garantida server-side).
  pr_number INTEGER,
  integration_branch TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_project ON checkpoints (project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_checkpoints_parent ON checkpoints (parent_checkpoint_id);

ALTER TABLE checkpoints ENABLE ROW LEVEL SECURITY;

-- Dono do PROJETO vê seus checkpoints (via join implícito por project ownership).
-- Escrita do daemon roda server-side (service_role); o client só lê os seus.
DROP POLICY IF EXISTS "checkpoints_owner_select" ON checkpoints;
CREATE POLICY "checkpoints_owner_select" ON checkpoints
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = checkpoints.project_id AND p.user_id = auth.uid()
    )
  );

-- Trigger de updated_at (padrão do schema).
DROP TRIGGER IF EXISTS trg_checkpoints_updated_at ON checkpoints;
CREATE TRIGGER trg_checkpoints_updated_at
  BEFORE UPDATE ON checkpoints
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── 3. repository_id do projeto (token por id exato) ────────────────────────
-- Guardar o id numérico do repo permite emitir o token com `repository_ids`
-- (escopo por id exato). Nullable: projeto antigo resolve on-demand por nome.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;

-- ============================================================
-- VERIFICAÇÃO — deve devolver 1 linha "ok"
-- ============================================================
SELECT 'checkpoint daemon' AS item,
       CASE WHEN
            EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'checkpoint_devices')
        AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'checkpoints')
        AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'checkpoint_devices'
                     AND policyname = 'checkpoint_devices_owner')
        AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'checkpoints'
                     AND policyname = 'checkpoints_owner_select')
        AND EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'projects' AND column_name = 'github_repo_id')
            THEN 'ok' ELSE 'FALTANDO' END AS status;
