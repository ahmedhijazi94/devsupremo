'use server'

import { revalidatePath } from 'next/cache'
import { randomBytes } from 'node:crypto'
import { requireUser, toActionError } from '@/lib/auth'
import { decryptToken, encryptToken } from '@/lib/crypto'
import {
  buildProjectFiles,
  TEMPLATE_VERSION,
  type FileEntry,
} from '@/lib/templates/project-files'
import {
  createProject as createVercelProject,
  findProjectByName,
  setEnvironmentVariables,
  VercelError,
} from '@/lib/vercel'

/**
 * Provisiona um projeto: cria o repositório, escreve o template completo,
 * cria o banco Supabase, aplica a migration inicial e protege a branch.
 *
 * O template é montado por `buildProjectFiles`, cujos testes garantem que o
 * resultado compila e passa nos próprios gates que ele declara.
 */

const GITHUB_API = 'https://api.github.com'
const SUPABASE_API = 'https://api.supabase.com'

/** Checks que precisam passar antes de qualquer merge na branch principal. */
const REQUIRED_CHECKS = [
  'Tipos, lint e auditoria',
  'Testes e cobertura',
  'Build de produção',
]

interface GithubRepo {
  id: number
  full_name: string
  default_branch: string
}

async function githubFetch(
  path: string,
  token: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  })
}

export async function scaffoldProject(
  projectId: string
): Promise<{ error?: string; warnings?: string[] }> {
  try {
    return await runScaffold(projectId)
  } catch (error) {
    console.error('[scaffold] falhou:', error)
    return { error: toActionError(error) }
  }
}

async function runScaffold(
  projectId: string
): Promise<{ error?: string; warnings?: string[] }> {
  const { user, supabase } = await requireUser()
  const warnings: string[] = []

  const { data: project } = await supabase
    .from('projects')
    .select('*, github_accounts (*), supabase_accounts (*)')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!project) return { error: 'Projeto não encontrado.' }
  if (project.github_repo_full_name) {
    return { error: 'Projeto já provisionado.' }
  }
  if (!project.github_accounts) {
    return { error: 'Conecte uma conta GitHub antes de provisionar.' }
  }

  const name = project.name as string
  const description = (project.description as string | null) ?? ''
  const githubToken = decryptToken(
    (project.github_accounts as { access_token_encrypted: string })
      .access_token_encrypted
  )

  // ── 1. Repositório ──────────────────────────────────────────
  const repoResponse = await githubFetch('/user/repos', githubToken, {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: description || `${name} — criado com Supremo`,
      private: true,
      auto_init: true,
    }),
  })

  if (!repoResponse.ok) {
    if (repoResponse.status === 422) {
      return { error: `O repositório "${name}" já existe na sua conta GitHub.` }
    }
    const detail = (await repoResponse.json()) as { message?: string }
    return { error: `Erro ao criar repositório: ${detail.message ?? repoResponse.status}` }
  }

  const repo = (await repoResponse.json()) as GithubRepo
  const branch = repo.default_branch || 'main'

  // O GitHub leva um instante para materializar a ref do commit inicial.
  const baseSha = await waitForBranch(repo.full_name, branch, githubToken)
  if (!baseSha) {
    return { error: 'O repositório foi criado mas a branch inicial não apareceu.' }
  }

  // ── 2. Template ─────────────────────────────────────────────
  const files = buildProjectFiles({ projectName: name, description })
  const commitSha = await commitTemplate(
    repo.full_name,
    branch,
    baseSha,
    githubToken,
    files
  )

  // ── 3. Banco Supabase ───────────────────────────────────────
  let supabaseProjectRef: string | null = null
  let dbPasswordEncrypted: string | null = null

  const supabaseAccountId = project.supabase_account_id as string | null

  if (supabaseAccountId) {
    const provisioned = await provisionSupabase(
      supabase,
      user.id,
      supabaseAccountId,
      name,
      files
    )

    supabaseProjectRef = provisioned.projectRef
    dbPasswordEncrypted = provisioned.dbPasswordEncrypted
    warnings.push(...provisioned.warnings)
  } else {
    warnings.push(
      'Nenhuma conta Supabase vinculada — o projeto foi criado sem banco.'
    )
  }

  // ── 4. Proteção de branch e análise estática ────────────────
  const protectionError = await protectBranch(
    repo.full_name,
    branch,
    githubToken
  )
  if (protectionError) warnings.push(protectionError)

  const scanningError = await enableCodeScanning(repo.full_name, githubToken)
  if (scanningError) warnings.push(scanningError)

  // ── 5. Preview na Vercel ────────────────────────────────────
  const preview = await linkVercel(
    supabase,
    user.id,
    name,
    repo.full_name,
    supabaseProjectRef
  )
  warnings.push(...preview.warnings)

  // ── 6. Persistência ─────────────────────────────────────────
  // O projeto recém-provisionado passa a ser o ativo: é nele que o usuário
  // vai trabalhar, e sem isso as ferramentas do MCP falham com "nenhum
  // projeto ativo" logo depois de criar o primeiro projeto.
  await supabase
    .from('projects')
    .update({ is_active: false })
    .eq('user_id', user.id)
    .neq('id', projectId)

  const { error: updateError } = await supabase
    .from('projects')
    .update({
      is_active: true,
      github_repo_full_name: repo.full_name,
      github_repo_id: repo.id,
      default_branch: branch,
      active_branch: branch,
      supabase_project_ref: supabaseProjectRef,
      db_password_encrypted: dbPasswordEncrypted,
      vercel_account_id: preview.accountId,
      vercel_project_id: preview.projectId,
      template_version: TEMPLATE_VERSION,
      status: 'active',
    })
    .eq('id', projectId)
    .eq('user_id', user.id)

  if (updateError) {
    return { error: 'Projeto criado no GitHub, mas falhou ao salvar no banco.' }
  }

  await supabase.from('audit_logs').insert({
    user_id: user.id,
    action: 'project.scaffold',
    resource_type: 'project',
    resource_id: projectId,
    metadata: {
      repo: repo.full_name,
      commit: commitSha,
      supabase_ref: supabaseProjectRef,
      template_version: TEMPLATE_VERSION,
      files: files.length,
    },
    ip_address: null,
  })

  revalidatePath('/', 'layout')
  return warnings.length > 0 ? { warnings } : {}
}

// ─────────────────────────────────────────────────────────────

async function waitForBranch(
  repoFullName: string,
  branch: string,
  token: string
): Promise<string | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await githubFetch(
      `/repos/${repoFullName}/git/ref/heads/${branch}`,
      token
    )

    if (response.ok) {
      const data = (await response.json()) as { object: { sha: string } }
      return data.object.sha
    }

    await sleep(1000 * (attempt + 1))
  }
  return null
}

async function commitTemplate(
  repoFullName: string,
  branch: string,
  baseSha: string,
  token: string,
  files: FileEntry[]
): Promise<string> {
  const baseCommitResponse = await githubFetch(
    `/repos/${repoFullName}/git/commits/${baseSha}`,
    token
  )
  if (!baseCommitResponse.ok) {
    throw new Error('Não foi possível ler o commit inicial do repositório.')
  }

  const baseCommit = (await baseCommitResponse.json()) as {
    tree: { sha: string }
  }

  const treeResponse = await githubFetch(
    `/repos/${repoFullName}/git/trees`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        base_tree: baseCommit.tree.sha,
        tree: files.map((file) => ({
          path: file.path,
          mode: file.mode ?? '100644',
          type: 'blob',
          content: file.content,
        })),
      }),
    }
  )

  if (!treeResponse.ok) {
    const detail = await treeResponse.text()
    throw new Error(`Erro ao escrever os arquivos: ${detail.slice(0, 200)}`)
  }

  const tree = (await treeResponse.json()) as { sha: string }

  const commitResponse = await githubFetch(
    `/repos/${repoFullName}/git/commits`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        message: [
          'feat: estrutura inicial do projeto',
          '',
          'Gerado pelo Supremo. Inclui:',
          '- Next.js 16 + React 19 + TypeScript strict',
          '- Supabase com RLS e migration versionada',
          '- Vitest, Playwright e testes de política RLS',
          '- CI com tipos, lint, cobertura, CodeQL, gitleaks e E2E',
          '- CSP e cabeçalhos de segurança em next.config.ts',
        ].join('\n'),
        tree: tree.sha,
        parents: [baseSha],
      }),
    }
  )

  if (!commitResponse.ok) {
    throw new Error('Erro ao criar o commit inicial.')
  }

  const commit = (await commitResponse.json()) as { sha: string }

  const refResponse = await githubFetch(
    `/repos/${repoFullName}/git/refs/heads/${branch}`,
    token,
    { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) }
  )

  if (!refResponse.ok) {
    throw new Error(`Erro ao atualizar a branch ${branch}.`)
  }

  return commit.sha
}

interface SupabaseProvisionResult {
  projectRef: string | null
  dbPasswordEncrypted: string | null
  warnings: string[]
}

async function provisionSupabase(
  supabase: Awaited<ReturnType<typeof requireUser>>['supabase'],
  userId: string,
  supabaseAccountId: string,
  name: string,
  files: FileEntry[]
): Promise<SupabaseProvisionResult> {
  const warnings: string[] = []

  const { data: account } = await supabase
    .from('supabase_accounts')
    .select('access_token_encrypted, org_slug')
    .eq('id', supabaseAccountId)
    .eq('user_id', userId)
    .maybeSingle()

  if (!account) {
    return {
      projectRef: null,
      dbPasswordEncrypted: null,
      warnings: ['Conta Supabase não encontrada.'],
    }
  }

  const token = decryptToken(account.access_token_encrypted as string)

  const orgsResponse = await fetch(`${SUPABASE_API}/v1/organizations`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!orgsResponse.ok) {
    return {
      projectRef: null,
      dbPasswordEncrypted: null,
      warnings: ['Não foi possível listar as organizações do Supabase.'],
    }
  }

  const orgs = (await orgsResponse.json()) as Array<{ id: string; slug: string }>
  const org =
    orgs.find((candidate) => candidate.slug === account.org_slug) ?? orgs[0]

  if (!org) {
    return {
      projectRef: null,
      dbPasswordEncrypted: null,
      warnings: ['Nenhuma organização disponível no Supabase.'],
    }
  }

  // A senha do banco é do usuário. A versão anterior gerava e descartava,
  // deixando o dono sem acesso direto ao próprio Postgres.
  const dbPassword = generateDbPassword()

  const createResponse = await fetch(`${SUPABASE_API}/v1/projects`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      organization_id: org.id,
      region: 'us-east-1',
      db_pass: dbPassword,
    }),
  })

  if (!createResponse.ok) {
    const detail = await createResponse.text()
    return {
      projectRef: null,
      dbPasswordEncrypted: null,
      warnings: [`Falha ao criar projeto Supabase: ${detail.slice(0, 160)}`],
    }
  }

  const created = (await createResponse.json()) as { ref: string }
  const dbPasswordEncrypted = encryptToken(dbPassword)

  const ready = await waitForSupabaseProject(created.ref, token)

  if (!ready) {
    warnings.push(
      'O banco Supabase ainda estava provisionando. Aplique a migration inicial ' +
        'pelo painel ou rode a ferramenta apply_migration quando ele ficar pronto.'
    )
    return { projectRef: created.ref, dbPasswordEncrypted, warnings }
  }

  // A mesma migration que foi versionada no repositório é a que roda aqui —
  // repositório e banco não divergem.
  const migration = files.find((file) =>
    file.path.startsWith('supabase/migrations/')
  )

  if (migration) {
    const migrationResponse = await fetch(
      `${SUPABASE_API}/v1/projects/${created.ref}/database/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: migration.content }),
      }
    )

    if (!migrationResponse.ok) {
      const detail = await migrationResponse.text()
      warnings.push(
        `A migration inicial está versionada em ${migration.path} mas o banco ` +
          `a recusou: ${detail.slice(0, 160)}`
      )
    }
  }

  return { projectRef: created.ref, dbPasswordEncrypted, warnings }
}

async function waitForSupabaseProject(
  projectRef: string,
  token: string
): Promise<boolean> {
  for (let attempt = 0; attempt < 24; attempt++) {
    await sleep(5000)

    const response = await fetch(`${SUPABASE_API}/v1/projects/${projectRef}`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (response.ok) {
      const data = (await response.json()) as { status: string }
      if (data.status === 'ACTIVE_HEALTHY') return true
    }
  }
  return false
}

/**
 * Protege a branch principal exigindo os gates.
 *
 * Sem isto o pipeline é contornável com um `git push`, e um gate que se
 * contorna não é um gate.
 */
async function protectBranch(
  repoFullName: string,
  branch: string,
  token: string
): Promise<string | null> {
  const response = await githubFetch(
    `/repos/${repoFullName}/branches/${branch}/protection`,
    token,
    {
      method: 'PUT',
      body: JSON.stringify({
        required_status_checks: { strict: true, contexts: REQUIRED_CHECKS },
        enforce_admins: false,
        required_pull_request_reviews: null,
        restrictions: null,
        allow_force_pushes: false,
        allow_deletions: false,
      }),
    }
  )

  if (response.ok) return null

  // Repositório privado em plano Free não tem proteção de branch.
  if (response.status === 403 || response.status === 404) {
    return (
      `A proteção da branch ${branch} não pôde ser aplicada (plano do GitHub). ` +
      'Os gates continuam rodando no CI, mas um push direto consegue contorná-los.'
    )
  }

  return `Não foi possível proteger a branch ${branch} (HTTP ${response.status}).`
}

interface VercelLinkResult {
  accountId: string | null
  projectId: string | null
  warnings: string[]
}

/**
 * Cria o projeto na Vercel ligado ao repositório.
 *
 * A partir daí a Vercel publica sozinha: cada branch vira um preview com URL
 * própria, e a branch principal vira produção. É o que substituiu o preview
 * em navegador — aquele não sobrevivia ao Next 16 e nunca gerou link que
 * pudesse ser compartilhado.
 */
async function linkVercel(
  supabase: Awaited<ReturnType<typeof requireUser>>['supabase'],
  userId: string,
  name: string,
  repoFullName: string,
  supabaseProjectRef: string | null
): Promise<VercelLinkResult> {
  const { data: account } = await supabase
    .from('vercel_accounts')
    .select('id, team_id, access_token_encrypted')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle()

  if (!account) {
    return {
      accountId: null,
      projectId: null,
      warnings: [
        'Sem conta Vercel conectada — o projeto ficou sem preview. ' +
          'Conecte uma em Contas e recrie o projeto, ou ligue o repositório ' +
          'na Vercel à mão.',
      ],
    }
  }

  const token = decryptToken(account.access_token_encrypted as string)
  const teamId = (account.team_id as string | null) ?? null

  try {
    // Nome já usado é caso comum ao recriar um projeto; reaproveitar é
    // melhor que falhar o provisionamento inteiro por causa disso.
    const existing = await findProjectByName(token, teamId, name)
    const project =
      existing ?? (await createVercelProject(token, teamId, name, repoFullName))

    if (supabaseProjectRef) {
      await setEnvironmentVariables(token, teamId, project.id, {
        NEXT_PUBLIC_SUPABASE_URL: `https://${supabaseProjectRef}.supabase.co`,
      })
    }

    return {
      accountId: account.id as string,
      projectId: project.id,
      warnings: existing
        ? [`Reaproveitado o projeto "${name}" que já existia na Vercel.`]
        : [],
    }
  } catch (error) {
    const detail =
      error instanceof VercelError ? error.message : String(error)

    return {
      accountId: account.id as string,
      projectId: null,
      warnings: [`Não foi possível criar o projeto na Vercel: ${detail}`],
    }
  }
}

/**
 * Liga o code scanning gerenciado do GitHub.
 *
 * Preferido a um job de CodeQL no workflow: o default setup é mantido pela
 * plataforma, não conflita com o workflow do projeto, e — o que mais importa
 * — quando o plano do repositório não permite, o resultado é um aviso aqui e
 * não um job vermelho em todo pull request. Gate que falha por motivo de
 * plano ensina a equipe a ignorar vermelho.
 */
async function enableCodeScanning(
  repoFullName: string,
  token: string
): Promise<string | null> {
  const response = await githubFetch(
    `/repos/${repoFullName}/code-scanning/default-setup`,
    token,
    {
      method: 'PUT',
      body: JSON.stringify({ state: 'configured', query_suite: 'extended' }),
    }
  )

  if (response.ok || response.status === 202) return null

  if (response.status === 403 || response.status === 404) {
    return (
      'A análise estática (CodeQL) não pôde ser ativada — repositório privado ' +
      'exige GitHub Advanced Security. Os demais gates seguem rodando.'
    )
  }

  return `Não foi possível ativar a análise estática (HTTP ${response.status}).`
}

function generateDbPassword(): string {
  // Alfabeto sem ambiguidade visual e sem caracteres que quebram URL de conexão.
  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = randomBytes(32)

  let password = ''
  for (const byte of bytes) {
    password += alphabet[byte % alphabet.length]
  }

  // Garante as classes que o Supabase exige.
  return `${password}Aa1-`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
