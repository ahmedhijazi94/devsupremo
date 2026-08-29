'use server'

import { createClient } from '@/lib/supabase/server'
import { decryptToken } from '@/lib/crypto'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { getSecurityAuditScriptContent, getCiWorkflowContent, getPackageJsonContent, getVitestConfigContent, getPlaywrightConfigContent, getVercelJsonContent, getTailwindConfigContent, getPostcssConfigContent, getGlobalsCssContent, getUtilsTsContent, getSupabaseClientContent, getSupabaseServerContent, getSupabaseMiddlewareContent, getNextMiddlewareContent } from '@/lib/templates/project-files'

const createProjectSchema = z.object({
  name: z
    .string()
    .min(2, 'Nome muito curto.')
    .max(50, 'Nome muito longo.')
    .regex(/^[a-z0-9-]+$/, 'Apenas letras minúsculas, números e hífens.'),
  description: z.string().max(200).optional(),
  githubAccountId: z.string().uuid('Selecione uma conta GitHub.'),
  supabaseAccountId: z.string().uuid().optional(),
  stack: z.enum(['nextjs', 'react', 'node']).default('nextjs'),
})

// ─────────────────────────────────────────────────────────────
// Gera os arquivos base do projeto (agents.md, CLAUDE.md, etc.)
// ─────────────────────────────────────────────────────────────
function generateAgentsMd(projectName: string, description: string, stack: string): string {
  return `# ${projectName} — Context for AI Agents

## Project Overview
${description || `${projectName} — built with Supremo`}

## Stack
- **Framework:** ${stack === 'nextjs' ? 'Next.js 15 (App Router)' : stack}
- **Language:** TypeScript (strict mode)
- **Database:** Supabase PostgreSQL + RLS
- **Auth:** Supabase Auth
- **Styling:** Tailwind CSS + shadcn/ui

## Architecture Rules
- ALL validation on the server — never on the client
- ALL database tables have RLS enabled
- NEVER expose service role key to the client
- NEVER trust client-provided user IDs — always use auth.uid()
- Server Components by default — Client Components only when needed
- Server Actions for all mutations

## Security Constraints
- No role escalation via frontend
- No direct DB access from client
- All admin checks via server-side auth
- Tokens encrypted with AES-256-GCM

## MCP Context
This project is managed by Supremo. The active MCP reads this file on every session to understand the project context, rules, and current state. When implementing features, always follow the architecture rules above.
`
}

function generateClaudeMd(projectName: string): string {
  return `# CLAUDE.md — Behavioral Rules for ${projectName}

## What You MUST Always Do
- Read this file and agents.md at the start of every session
- Implement features server-side first
- Enable RLS on every new table you create
- Write Zod schemas for every input validation
- Add TypeScript types for every new DB table
- Use Server Actions for all data mutations

## What You MUST Never Do
- Add validation logic to client components
- Use \`any\` type without explicit comment explaining why
- Create a table without RLS policies
- Store tokens or secrets in plaintext
- Trust user input without server-side validation
- Escalate user roles via frontend logic

## Commit Convention
- feat: new feature
- fix: bug fix
- security: security improvement
- refactor: code refactor
- test: test addition/update
- docs: documentation

## Testing Requirements (before every commit)
1. TypeScript: \`tsc --noEmit\`
2. ESLint: \`eslint .\`
3. Unit Tests: \`vitest run\`
4. Build: \`next build\`
`
}

function generateSecurityMd(projectName: string): string {
  return `# SECURITY.md — Security Policy for ${projectName}

## RLS Policy Template
Every table must have:
\`\`\`sql
ALTER TABLE table_name ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_only" ON table_name
  FOR ALL USING (auth.uid() = user_id);
\`\`\`

## Forbidden Patterns
- \`SELECT * FROM table WHERE id = $clientProvidedId\` without auth check
- Using \`service_role\` key client-side
- JWT decode client-side for auth decisions
- \`dangerouslySetInnerHTML\` without sanitization
- Storing PII in plaintext

## Security Headers
All configured in next.config.ts:
- Strict-Transport-Security
- X-Frame-Options: DENY
- X-Content-Type-Options: nosniff
- Content-Security-Policy

## Incident Response
If a security issue is found:
1. Do NOT commit the fix directly
2. Create a \`security/fix-description\` branch
3. Apply the fix
4. Run full test pipeline
5. Request review before merging
`
}

function generateReadme(projectName: string, description: string, stack: string): string {
  return `# ${projectName}

${description || 'Built with Supremo — AI-powered development platform'}

## Stack
- ${stack === 'nextjs' ? 'Next.js 15 (App Router) + TypeScript' : stack}
- Supabase (PostgreSQL + Auth + RLS)
- Tailwind CSS + shadcn/ui

## Security
- RLS enabled on all tables
- Server-side validation only (Zod)
- AES-256-GCM token encryption
- Security headers configured

## Getting Started

\`\`\`bash
npm install
cp .env.example .env.local
# Fill in your Supabase credentials
npm run dev
\`\`\`

## Architecture
See [agents.md](./agents.md) for full project context and rules.

---
*Created with [Supremo](https://github.com/supremo)*
`
}

function generateEnvExample(): string {
  return `# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Encryption
ENCRYPTION_KEY=your-64-char-hex-key

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
`
}

function generateGitignore(): string {
  return `.env.local
.env.*.local
node_modules/
.next/
out/
dist/
*.log
.DS_Store
coverage/
playwright-report/
docs/security-audit/last-audit.json
`
}

// ─────────────────────────────────────────────────────────────
// GitHub API helpers
// ─────────────────────────────────────────────────────────────

async function githubRequest(
  path: string,
  token: string,
  options: RequestInit = {}
) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers ?? {}),
    },
  })
  return res
}

export async function scaffoldProject(
  projectId: string
): Promise<{ error?: string }> {

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Não autorizado.' }

  // 1. Fetch project details
  const { data: project } = await supabase
    .from('projects')
    .select(`
      *,
      github_accounts (*),
      supabase_accounts (*)
    `)
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()

  if (!project) return { error: 'Projeto não encontrado.' }
  if (!project.github_accounts) return { error: 'Conta GitHub não vinculada.' }
  if (project.github_repo_full_name) return { error: 'Projeto já provisionado.' }

  const { name, description, github_accounts: githubAccount, supabase_account_id: supabaseAccountId } = project
  const stack = 'nextjs'

  const githubToken = decryptToken(githubAccount.access_token_encrypted)

  // 3. Criar repositório no GitHub com auto_init para garantir branch main
  const repoRes = await githubRequest('/user/repos', githubToken, {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: description ?? `${name} — built with Supremo`,
      private: true,
      auto_init: true, // Cria branch main com commit inicial
    }),
  })

  if (!repoRes.ok) {
    const err = await repoRes.json() as { message?: string }
    if (repoRes.status === 422) {
      return { error: `Repositório "${name}" já existe na sua conta GitHub.` }
    }
    return { error: `Erro ao criar repositório: ${err.message ?? 'Unknown error'}` }
  }

  const repo = await repoRes.json() as {
    id: number
    full_name: string
    html_url: string
    default_branch: string
  }

  // Aguardar GitHub provisionar o repo (evitar race condition)
  await new Promise(resolve => setTimeout(resolve, 2000))

  // 4. Buscar SHA do commit inicial da branch main
  const branchRes = await githubRequest(
    `/repos/${repo.full_name}/git/ref/heads/main`,
    githubToken
  )

  if (!branchRes.ok) {
    // Tentar 'master' se 'main' não existir
    const masterRes = await githubRequest(
      `/repos/${repo.full_name}/git/ref/heads/master`,
      githubToken
    )
    if (!masterRes.ok) {
      return { error: 'Erro ao buscar branch inicial do repositório.' }
    }
  }

  const branchData = await branchRes.json() as { object: { sha: string } }
  const baseSha = branchData.object.sha

  // Buscar tree do commit inicial
  const baseCommitRes = await githubRequest(
    `/repos/${repo.full_name}/git/commits/${baseSha}`,
    githubToken
  )

  if (!baseCommitRes.ok) {
    return { error: 'Erro ao buscar commit inicial.' }
  }

  const baseCommit = await baseCommitRes.json() as { tree: { sha: string } }

  // 5. Gerar conteúdo dos arquivos
  const agentsMd = generateAgentsMd(name, description ?? '', stack)
  const claudeMd = generateClaudeMd(name)
  const securityMd = generateSecurityMd(name)
  const readme = generateReadme(name, description ?? '', stack)
  const envExample = generateEnvExample()
  const gitignore = generateGitignore()
  const securityAuditScript = getSecurityAuditScriptContent()
  const ciWorkflow = getCiWorkflowContent(name)
  const packageJson = getPackageJsonContent(name)
  const vitestConfig = getVitestConfigContent()
  const playwrightConfig = getPlaywrightConfigContent()
  const vercelJson = getVercelJsonContent()
  const tailwindConfig = getTailwindConfigContent()
  const postcssConfig = getPostcssConfigContent()
  const globalsCss = getGlobalsCssContent()
  const utilsTs = getUtilsTsContent()
  const sbClient = getSupabaseClientContent()
  const sbServer = getSupabaseServerContent()
  const sbMiddleware = getSupabaseMiddlewareContent()
  const nextMiddleware = getNextMiddlewareContent()

  // 6. Criar nova tree baseada na tree inicial (substitui README.md padrão)
  const treeRes = await githubRequest(
    `/repos/${repo.full_name}/git/trees`,
    githubToken,
    {
      method: 'POST',
      body: JSON.stringify({
        base_tree: baseCommit.tree.sha,
        tree: [
          { path: 'README.md', mode: '100644', type: 'blob', content: readme },
          { path: 'agents.md', mode: '100644', type: 'blob', content: agentsMd },
          { path: 'CLAUDE.md', mode: '100644', type: 'blob', content: claudeMd },
          { path: 'SECURITY.md', mode: '100644', type: 'blob', content: securityMd },
          { path: '.env.example', mode: '100644', type: 'blob', content: envExample },
          { path: '.gitignore', mode: '100644', type: 'blob', content: gitignore },
          { path: 'scripts/security-audit.js', mode: '100755', type: 'blob', content: securityAuditScript },
          { path: '.github/workflows/ci.yml', mode: '100644', type: 'blob', content: ciWorkflow },
          { path: 'package.json', mode: '100644', type: 'blob', content: packageJson },
          { path: 'vitest.config.ts', mode: '100644', type: 'blob', content: vitestConfig },
          { path: 'playwright.config.ts', mode: '100644', type: 'blob', content: playwrightConfig },
          { path: 'vitest.setup.ts', mode: '100644', type: 'blob', content: "import '@testing-library/jest-dom'" },
          
          
          { path: 'tailwind.config.ts', mode: '100644', type: 'blob', content: tailwindConfig },
          { path: 'postcss.config.js', mode: '100644', type: 'blob', content: postcssConfig },
          { path: 'app/globals.css', mode: '100644', type: 'blob', content: globalsCss },
          { path: 'lib/utils.ts', mode: '100644', type: 'blob', content: utilsTs },
          
          { path: 'lib/supabase/client.ts', mode: '100644', type: 'blob', content: sbClient },
          { path: 'lib/supabase/server.ts', mode: '100644', type: 'blob', content: sbServer },
          { path: 'lib/supabase/middleware.ts', mode: '100644', type: 'blob', content: sbMiddleware },
          { path: 'middleware.ts', mode: '100644', type: 'blob', content: nextMiddleware },
          { path: 'app/layout.tsx', mode: '100644', type: 'blob', content: "import './globals.css';\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) { return ( <html lang='en'><body>{children}</body></html> ); }" },
          { path: 'app/page.tsx', mode: '100644', type: 'blob', content: "export default function Home() { return <main><h1>Supremo App</h1></main>; }" },
          { path: '.eslintrc.json', mode: '100644', type: 'blob', content: '{ "extends": "next/core-web-vitals" }' },
          { path: 'vercel.json', mode: '100644', type: 'blob', content: vercelJson },
          { path: 'tsconfig.json', mode: '100644', type: 'blob', content: JSON.stringify({ compilerOptions: { lib: ["dom", "dom.iterable", "esnext"], allowJs: true, skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true, module: "esnext", moduleResolution: "bundler", resolveJsonModule: true, isolatedModules: true, jsx: "preserve", incremental: true, plugins: [{ name: "next" }], paths: { "@/*": ["./*"] } }, include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"], exclude: ["node_modules"] }, null, 2) },

          { path: 'e2e/example.spec.ts', mode: '100644', type: 'blob', content: "import { test, expect } from '@playwright/test';\n\ntest('has title', async ({ page }) => {\n  await page.goto('/');\n  await expect(page).toHaveTitle(/Create Next App/);\n});" },
        ],
      }),
    }
  )

  if (!treeRes.ok) {
    return { error: 'Erro ao criar arquivos no repositório.' }
  }

  const tree = await treeRes.json() as { sha: string }

  // 7. Criar commit com parent no commit inicial
  const commitRes = await githubRequest(
    `/repos/${repo.full_name}/git/commits`,
    githubToken,
    {
      method: 'POST',
      body: JSON.stringify({
        message: 'feat: initial project setup via Supremo\n\n- agents.md: AI agent context\n- CLAUDE.md: MCP behavioral rules\n- SECURITY.md: security policies\n- .env.example: environment variables template',
        tree: tree.sha,
        parents: [baseSha], // Filho do commit inicial
      }),
    }
  )

  if (!commitRes.ok) {
    return { error: 'Erro ao criar commit inicial.' }
  }

  const commit = await commitRes.json() as { sha: string }

  // 8. Atualizar a ref da branch main para apontar pro novo commit (PATCH — branch já existe)
  const refRes = await githubRequest(
    `/repos/${repo.full_name}/git/refs/heads/main`,
    githubToken,
    {
      method: 'PATCH',
      body: JSON.stringify({
        sha: commit.sha,
        force: false,
      }),
    }
  )

  if (!refRes.ok) {
    return { error: 'Erro ao atualizar branch main.' }
  }

  // ─────────────────────────────────────────────────────────────
  // 9. Criar projeto Supabase (se conta conectada)
  // ─────────────────────────────────────────────────────────────
  let supabaseProjectRef: string | null = null

  if (supabaseAccountId) {
    const { data: sbAccount } = await supabase
      .from('supabase_accounts')
      .select('*')
      .eq('id', supabaseAccountId)
      .eq('user_id', user.id)
      .single()

    if (sbAccount) {
      const sbToken = decryptToken(sbAccount.access_token_encrypted)

      // Buscar org_id da organização
      const orgsRes = await fetch('https://api.supabase.com/v1/organizations', {
        headers: { Authorization: `Bearer ${sbToken}` },
      })

      if (orgsRes.ok) {
        const orgs = await orgsRes.json() as Array<{ id: string; slug: string }>
        const org = orgs.find(o => o.slug === sbAccount.org_slug) ?? orgs[0]

        if (org) {
          // Gerar senha forte para o banco
          const { randomBytes } = await import('crypto')
          const dbPassword = randomBytes(24).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32) + 'Aa1!'

          // Criar projeto Supabase
          const createProjRes = await fetch('https://api.supabase.com/v1/projects', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${sbToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name,
              organization_id: org.id,
              plan: 'free',
              region: 'us-east-1',
              db_pass: dbPassword,
            }),
          })

          if (createProjRes.ok) {
            const sbProject = await createProjRes.json() as { id: string; ref: string; status: string }
            supabaseProjectRef = sbProject.ref

            // Aguardar provisionamento (polling por até 90s)
            let attempts = 0
            let ready = false
            while (attempts < 18 && !ready) {
              await new Promise(r => setTimeout(r, 5000))
              const statusRes = await fetch(`https://api.supabase.com/v1/projects/${sbProject.ref}`, {
                headers: { Authorization: `Bearer ${sbToken}` },
              })
              if (statusRes.ok) {
                const status = await statusRes.json() as { status: string }
                if (status.status === 'ACTIVE_HEALTHY') {
                  ready = true
                }
              }
              attempts++
            }

            // Aplicar migration inicial se provisionado
            if (ready) {
              const baseMigration = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit_logs_read_own" ON audit_logs FOR SELECT USING (auth.uid()::text = user_id::text);
CREATE POLICY "audit_logs_insert_own" ON audit_logs FOR INSERT WITH CHECK (true);
`
              await fetch(`https://api.supabase.com/v1/projects/${sbProject.ref}/database/query`, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${sbToken}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query: baseMigration }),
              })
            }
          }
        }
      }
    }
  }

  // 10. Atualizar projeto no Supremo DB com dados do provisionamento
  const { error: projectError } = await supabase
    .from('projects')
    .update({
      github_repo_full_name: repo.full_name,
      github_repo_id: repo.id,
      supabase_project_ref: supabaseProjectRef,
      status: 'active',
    })
    .eq('id', projectId)
    .eq('user_id', user.id)

  if (projectError) {
    return { error: 'Erro ao atualizar projeto no banco.' }
  }

  // 11. Log de auditoria
  await supabase.from('audit_logs').insert({
    user_id: user.id,
    action: 'project.scaffold',
    resource_type: 'project',
    resource_id: projectId,
    metadata: {
      name,
      github_repo: repo.full_name,
      commit_sha: commit.sha,
      supabase_ref: supabaseProjectRef,
    },
  })

  revalidatePath('/', 'layout')

  return {}
}
