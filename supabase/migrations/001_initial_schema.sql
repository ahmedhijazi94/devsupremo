-- ============================================================
-- SUPREMO — Migration 001: Schema Completo
-- ============================================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- GITHUB ACCOUNTS
-- ============================================================
CREATE TABLE IF NOT EXISTS github_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  github_user_id BIGINT NOT NULL,
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  access_token_encrypted TEXT NOT NULL,  -- AES-256-GCM encrypted
  refresh_token_encrypted TEXT,
  scopes TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE(user_id, github_user_id)
);

CREATE INDEX idx_github_accounts_user_id ON github_accounts(user_id);

ALTER TABLE github_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "github_accounts_owner_only" ON github_accounts
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- SUPABASE ACCOUNTS
-- ============================================================
CREATE TABLE IF NOT EXISTS supabase_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  org_name TEXT NOT NULL,
  org_slug TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,  -- AES-256-GCM encrypted
  refresh_token_encrypted TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE(user_id, org_slug)
);

CREATE INDEX idx_supabase_accounts_user_id ON supabase_accounts(user_id);

ALTER TABLE supabase_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "supabase_accounts_owner_only" ON supabase_accounts
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- PROJECTS
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  github_account_id UUID REFERENCES github_accounts(id) ON DELETE SET NULL,
  supabase_account_id UUID REFERENCES supabase_accounts(id) ON DELETE SET NULL,
  github_repo_full_name TEXT,   -- "owner/repo"
  github_repo_id BIGINT,
  supabase_project_ref TEXT,
  cloudflare_project_name TEXT,
  active_mcp TEXT DEFAULT 'antigravity' NOT NULL,
  active_branch TEXT DEFAULT 'main' NOT NULL,
  preview_url TEXT,
  status TEXT DEFAULT 'active' NOT NULL CHECK (status IN ('active', 'creating', 'error', 'archived')),
  is_active BOOLEAN DEFAULT FALSE NOT NULL,  -- apenas 1 ativo por usuário
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_projects_user_id ON projects(user_id);
CREATE INDEX idx_projects_github_account ON projects(github_account_id);
CREATE INDEX idx_projects_supabase_account ON projects(supabase_account_id);
CREATE INDEX idx_projects_is_active ON projects(user_id, is_active) WHERE is_active = TRUE;

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "projects_owner_only" ON projects
  FOR ALL USING (auth.uid() = user_id);

-- Garantir apenas 1 projeto ativo por usuário
CREATE UNIQUE INDEX idx_one_active_project_per_user
  ON projects(user_id)
  WHERE is_active = TRUE;

-- ============================================================
-- MESSAGES (histórico de prompts → commits)
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  commit_sha TEXT,
  commit_message TEXT,
  files_changed JSONB,  -- [{path, additions, deletions, status}]
  pipeline_status TEXT CHECK (pipeline_status IN ('pending', 'running', 'passed', 'failed')),
  pipeline_log JSONB,   -- log detalhado de cada fase do pipeline
  mcp_used TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_messages_project_id ON messages(project_id);
CREATE INDEX idx_messages_user_id ON messages(user_id);
CREATE INDEX idx_messages_created_at ON messages(project_id, created_at DESC);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Usuário só vê mensagens dos seus próprios projetos
CREATE POLICY "messages_owner_only" ON messages
  FOR ALL USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = messages.project_id
        AND projects.user_id = auth.uid()
    )
  );

-- ============================================================
-- MCP CONFIGS
-- ============================================================
CREATE TABLE IF NOT EXISTS mcp_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('antigravity', 'claude', 'openai', 'custom')),
  endpoint_url TEXT,
  api_key_encrypted TEXT,  -- AES-256-GCM encrypted
  is_active BOOLEAN DEFAULT TRUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_mcp_configs_user_id ON mcp_configs(user_id);

ALTER TABLE mcp_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mcp_configs_owner_only" ON mcp_configs
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- AUDIT LOGS (imutável — sem UPDATE/DELETE policy)
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,        -- 'project.create', 'account.connect', etc.
  resource_type TEXT NOT NULL, -- 'project', 'github_account', etc.
  resource_id TEXT,
  metadata JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Usuário só vê seus próprios logs, não pode modificar
CREATE POLICY "audit_logs_read_own" ON audit_logs
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "audit_logs_insert_own" ON audit_logs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- TRIGGERS: updated_at automático
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER github_accounts_updated_at
  BEFORE UPDATE ON github_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER supabase_accounts_updated_at
  BEFORE UPDATE ON supabase_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER mcp_configs_updated_at
  BEFORE UPDATE ON mcp_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
