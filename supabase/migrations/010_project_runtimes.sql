-- Runtime de desenvolvimento por projeto (Fase A da migração para Codespaces).
--
-- Hoje o "motor" de dev é GitHub Actions (gates) + Vercel (build/preview) — tudo
-- fora do processo, minutos por ciclo. A evolução dá a cada projeto um ambiente
-- de desenvolvimento online (Codespace) com dev server/HMR e testes em segundo
-- plano. Estas tabelas são só o ESTADO no Supremo; nenhuma credencial mora aqui.
--
-- Nada é destrutivo: colunas/tabelas novas, aditivas. O caminho atual
-- (Vercel/Actions) segue funcionando até o runtime assumir, projeto a projeto.

-- Um runtime por projeto. UNIQUE(project_id) evita dois Codespaces por engano.
CREATE TABLE IF NOT EXISTS project_runtimes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL UNIQUE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  provider text NOT NULL DEFAULT 'codespaces',
  -- Identidade no provedor. codespace_name é o nome único do GitHub. O backend
  -- SEMPRE resolve isto a partir do project_id — nunca confia em nome vindo do
  -- cliente (isolamento entre projetos).
  provider_runtime_id text,
  codespace_name text,
  status text NOT NULL DEFAULT 'offline'
    CHECK (status IN ('offline', 'starting', 'online', 'stopping', 'error')),
  preview_status text NOT NULL DEFAULT 'offline'
    CHECK (preview_status IN ('offline', 'starting', 'ready', 'error')),
  preview_url text,
  dev_port integer,
  -- Setup inicial do ambiente (bootstrap). Falha aqui NÃO destrói GitHub/Supabase:
  -- o projeto existe e permite "Retry Setup Runtime".
  setup_status text NOT NULL DEFAULT 'pending'
    CHECK (setup_status IN ('pending', 'running', 'ready', 'setup_failed')),
  setup_error text,
  last_active_at timestamptz,
  last_started_at timestamptz,
  last_stopped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_runtimes_project ON project_runtimes (project_id);

ALTER TABLE project_runtimes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "project_runtimes_owner" ON project_runtimes
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER project_runtimes_updated_at
  BEFORE UPDATE ON project_runtimes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Resultado das validações em segundo plano (testes fora do caminho crítico).
CREATE TABLE IF NOT EXISTS validation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  -- 'fast' (incremental durante o dev) ou 'full' (finalização/pré-produção).
  kind text NOT NULL DEFAULT 'fast' CHECK (kind IN ('fast', 'full')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'passed', 'failed', 'stale')),
  -- Revisão testada (commit/worktree), para saber a que estado o resultado vale.
  revision text,
  summary text,
  duration_ms integer,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_validation_runs_project ON validation_runs (project_id, created_at DESC);

ALTER TABLE validation_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "validation_runs_owner" ON validation_runs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Sessão de agente, para o handoff Codex <-> Claude: quem mexeu, em que branch,
-- o que estava fazendo. O ESTADO vive no Supremo, não na memória do modelo.
CREATE TABLE IF NOT EXISTS agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  agent text NOT NULL,
  branch text,
  summary text,
  files_changed jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'handed_off', 'done')),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions (project_id, last_active_at DESC);

ALTER TABLE agent_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agent_sessions_owner" ON agent_sessions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER agent_sessions_updated_at
  BEFORE UPDATE ON agent_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
