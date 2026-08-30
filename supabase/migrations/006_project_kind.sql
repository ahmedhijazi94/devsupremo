-- ============================================================
-- SUPREMO — Migration 006
--
-- Idempotente. O tipo do app é escolhido na criação: público, com login
-- (solo), ou multi-tenant (team). É uma decisão arquitetural cara de
-- reverter, então é gravada no projeto e usada pelo scaffold para montar a
-- migration e os arquivos certos.
--
-- Projetos que já existem viram 'solo' — o comportamento que tinham antes de
-- a escolha existir.
-- ============================================================

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'solo';

-- Só os três tipos que o scaffold entende. Constraint nomeada e adicionada de
-- forma idempotente.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_kind_check'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_kind_check
      CHECK (kind IN ('public', 'solo', 'team'));
  END IF;
END $$;

-- ============================================================
-- VERIFICAÇÃO — deve devolver 1 linha "ok"
-- ============================================================
SELECT 'coluna kind com constraint' AS item,
       CASE WHEN (SELECT count(*) FROM information_schema.columns
                  WHERE table_name = 'projects' AND column_name = 'kind') = 1
             AND EXISTS (SELECT 1 FROM pg_constraint
                         WHERE conname = 'projects_kind_check')
            THEN 'ok' ELSE 'FALTANDO' END AS status;
