-- ============================================================
-- SUPREMO — Migration 017
--
-- Workflow v3.1 (finalização): Histórico + Restore dentro do próprio Supremo.
--
-- NÃO altera a migration 016 (já aplicada em produção) — só ADICIONA. O usuário
-- não deve mais precisar abrir o GitHub para ver o que mudou ou para voltar a um
-- ponto anterior; esta migration dá ao backend os campos para isso:
--
--   1. checkpoints — associação com a conversa/turno de origem (quando o host do
--      agente fornecer) e marca de "isto é resultado de um restore";
--   2. checkpoint_restore_requests — o pedido de "Restaurar X", que o Control
--      Plane cria e o checkpoint daemon da MÁQUINA original consome, aplica
--      localmente (preview atualiza via HMR) e fecha com um NOVO checkpoint —
--      nunca reescrevendo histórico, nunca resetando a main.
--
-- Restore NÃO é bypass: o checkpoint resultante passa pelos MESMOS gates
-- (publish → PR → CI → auto-merge) de qualquer outro checkpoint.
--
-- Idempotente. NÃO edita a migration 016. Só adiciona.
-- ============================================================

-- ── 1. checkpoints: origem da conversa + marca de restore ──────────────────
-- Genérico (não amarra a Codex nem a Claude): populado quando o host do agente
-- fornecer a metadata; ausência não quebra nada — o resumo continua funcional.
ALTER TABLE checkpoints
  ADD COLUMN IF NOT EXISTS conversation_id TEXT;
ALTER TABLE checkpoints
  ADD COLUMN IF NOT EXISTS message_id TEXT;
ALTER TABLE checkpoints
  ADD COLUMN IF NOT EXISTS origin_agent TEXT;

-- Quando este checkpoint é o "E" resultante de um "Restaurar B", aponta para B.
-- ON DELETE SET NULL: apagar o checkpoint alvo (não deveria acontecer — checkpoints
-- não têm rota de exclusão) nunca quebra o histórico dos demais.
ALTER TABLE checkpoints
  ADD COLUMN IF NOT EXISTS restored_from_checkpoint_id UUID
    REFERENCES checkpoints(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_checkpoints_restored_from
  ON checkpoints (restored_from_checkpoint_id);

-- ── 2. Pedidos de restore ───────────────────────────────────────────────────
-- pending  → o usuário clicou "Restaurar" na UI do Supremo; aguardando o daemon
--            da máquina original.
-- claimed  → um device pegou o pedido (evita dois daemons aplicarem o mesmo
--            restore, caso a mesma máquina rode duas instâncias por engano).
-- applied  → aplicado localmente; result_checkpoint_id aponta pro novo checkpoint
--            "E" (que segue o fluxo normal de publish/CI/merge).
-- failed   → não deu (ex.: o commit alvo não existe no histórico local desta
--            máquina — restore hoje é por-máquina, documentado no relatório).
CREATE TABLE IF NOT EXISTS checkpoint_restore_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  target_checkpoint_id UUID REFERENCES checkpoints(id) ON DELETE CASCADE NOT NULL,
  requested_by UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  -- Preenchido quando um device CLAIMA o pedido (não no INSERT do usuário).
  device_id UUID REFERENCES checkpoint_devices(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'applied', 'failed')),
  -- O novo checkpoint "E" que representa o resultado do restore.
  result_checkpoint_id UUID REFERENCES checkpoints(id) ON DELETE SET NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_restore_requests_project_status
  ON checkpoint_restore_requests (project_id, status);
CREATE INDEX IF NOT EXISTS idx_restore_requests_target
  ON checkpoint_restore_requests (target_checkpoint_id);

ALTER TABLE checkpoint_restore_requests ENABLE ROW LEVEL SECURITY;

-- O DONO do projeto vê seus próprios pedidos de restore.
DROP POLICY IF EXISTS "restore_requests_owner_select" ON checkpoint_restore_requests;
CREATE POLICY "restore_requests_owner_select" ON checkpoint_restore_requests
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = checkpoint_restore_requests.project_id AND p.user_id = auth.uid()
    )
  );

-- O DONO do projeto pode pedir restore de um checkpoint do PRÓPRIO projeto —
-- nunca em nome de outro usuário (requested_by = auth.uid()) nem de projeto
-- alheio. Claim/apply/failed são escritos SERVER-SIDE (service_role, pela rota
-- do daemon) — sem policy de UPDATE para client, RLS nega por padrão.
DROP POLICY IF EXISTS "restore_requests_owner_insert" ON checkpoint_restore_requests;
CREATE POLICY "restore_requests_owner_insert" ON checkpoint_restore_requests
  FOR INSERT
  WITH CHECK (
    requested_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = checkpoint_restore_requests.project_id AND p.user_id = auth.uid()
    )
  );

DROP TRIGGER IF EXISTS trg_restore_requests_updated_at ON checkpoint_restore_requests;
CREATE TRIGGER trg_restore_requests_updated_at
  BEFORE UPDATE ON checkpoint_restore_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- VERIFICAÇÃO — deve devolver 1 linha "ok"
-- ============================================================
SELECT 'checkpoint history + restore' AS item,
       CASE WHEN
            (SELECT count(*) FROM information_schema.columns
              WHERE table_name = 'checkpoints'
                AND column_name IN (
                  'conversation_id','message_id','origin_agent','restored_from_checkpoint_id'
                )) = 4
        AND EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_name = 'checkpoint_restore_requests')
        AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'checkpoint_restore_requests'
                     AND policyname = 'restore_requests_owner_select')
        AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'checkpoint_restore_requests'
                     AND policyname = 'restore_requests_owner_insert')
            THEN 'ok' ELSE 'FALTANDO' END AS status;
