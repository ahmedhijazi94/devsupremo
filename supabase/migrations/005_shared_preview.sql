-- ============================================================
-- SUPREMO — Migration 005
--
-- Idempotente. Preview compartilhado: publicado na conta Vercel do próprio
-- Supremo, com os arquivos enviados por ele. O usuário não precisa conectar
-- Vercel nem autorizar o app dela no GitHub — só GitHub e Supabase.
--
-- A conta do usuário continua servindo para produção, quando ele quiser o
-- site no ar com domínio próprio.
-- ============================================================

-- Nome do projeto na conta compartilhada. Derivado do id, guardado para o
-- caso de o esquema de nomes mudar sem quebrar os projetos existentes.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_project_name TEXT;

-- Última URL publicada, para a interface abrir sem consultar a API.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_url_shared TEXT;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_projects_preview_name
  ON projects(preview_project_name)
  WHERE preview_project_name IS NOT NULL;

-- ============================================================
-- VERIFICAÇÃO — deve devolver 1 linha "ok"
-- ============================================================
SELECT 'colunas de preview compartilhado' AS item,
       CASE WHEN (SELECT count(*) FROM information_schema.columns
                  WHERE table_name = 'projects'
                    AND column_name IN ('preview_project_name',
                                        'preview_url_shared',
                                        'preview_updated_at')) = 3
            THEN 'ok' ELSE 'FALTANDO' END AS status;
