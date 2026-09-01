'use server'

import { revalidatePath } from 'next/cache'
import { randomBytes } from 'node:crypto'
import { requireUser, toActionError } from '@/lib/auth'
import { decryptToken, encryptToken } from '@/lib/crypto'
import {
  buildProjectFiles,
  CI_JOB_NAMES,
  type ProjectKind,
  TEMPLATE_VERSION,
  SECURITY_BASELINE_VERSION,
  type FileEntry,
} from '@/lib/templates/project-files'
import { capabilitiesForKind, inferSecurityProfile } from '@/lib/capabilities'
import {
  runProvisioning,
  type ProvisioningSteps,
  type StepDef,
} from '@/lib/provisioning/engine'

/**
 * Vercel saiu do fluxo ativo do control plane v2: as integrações principais por
 * projeto são GitHub + Supabase, e o preview de dev é localhost (via bootstrap).
 * A integração NÃO foi deletada — `lib/vercel.ts` e as contas Vercel continuam
 * existindo; só não são mais chamadas no provisioning. Para religar um deploy
 * explícito, reintroduza a chamada aqui usando `lib/vercel.ts`.
 */

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
/**
 * Todo gate do CI é obrigatório para o merge. A lista vem do gerador do
 * workflow, não de uma cópia: gate que não bloqueia é relatório, não gate.
 */
const REQUIRED_CHECKS = [...CI_JOB_NAMES]

interface GithubRepo {
  id: number
  full_name: string
  default_branch: string
}

async function githubFetch(
  path: string,
  token: string,
  init: RequestInit = {},
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
  projectId: string,
): Promise<{ error?: string; warnings?: string[] }> {
  try {
    return await runScaffold(projectId)
  } catch (error) {
    console.error('[scaffold] falhou:', error)
    const message = toActionError(error)
    // Best-effort: registra a falha na máquina de estados (não relança).
    try {
      const { user, supabase } = await requireUser()
      await supabase
        .from('projects')
        .update({ provisioning_state: 'failed', provisioning_error: message })
        .eq('id', projectId)
        .eq('user_id', user.id)
    } catch {
      // sem sessão / sem acesso: nada a marcar
    }
    return { error: message }
  }
}

type ScaffoldCtx = Record<string, unknown>

async function runScaffold(
  projectId: string,
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
  // Só bloqueia se REALMENTE concluído. Provisionamento a meio (failed/parcial)
  // pode ser retomado — o motor pula os passos já feitos.
  if (project.provisioning_state === 'ready' && project.github_repo_full_name) {
    return { error: 'Projeto já provisionado.' }
  }
  if (!project.github_accounts) {
    return { error: 'Conecte uma conta GitHub antes de provisionar.' }
  }

  const name = project.name as string
  const description = (project.description as string | null) ?? ''
  // O tipo escolhido na criação decide a migration e os arquivos. Projeto
  // antigo, de antes da coluna existir, cai em 'solo'.
  const kind = ((project.kind as string | null) ?? 'solo') as ProjectKind
  const capabilities = capabilitiesForKind(kind)
  const securityProfile = inferSecurityProfile(capabilities, { kind })
  const githubToken = decryptToken(
    (project.github_accounts as { access_token_encrypted: string })
      .access_token_encrypted,
  )
  const supabaseAccountId = project.supabase_account_id as string | null
  const files = buildProjectFiles({
    projectName: name,
    description,
    kind,
    capabilities,
    projectId,
  })

  // Passos já concluídos numa tentativa anterior (resume).
  const persisted = ((project.provisioning_steps as ProvisioningSteps | null) ??
    {}) as ProvisioningSteps

  // ── Hooks de persistência ───────────────────────────────────
  const setState = async (state: string): Promise<void> => {
    await supabase
      .from('projects')
      .update({ provisioning_state: state, provisioning_error: null })
      .eq('id', projectId)
      .eq('user_id', user.id)
  }

  const persistStep = async (
    stepName: string,
    record: { status: 'pending' | 'done'; output?: Record<string, unknown> },
  ): Promise<void> => {
    persisted[stepName] = record
    const out = record.output ?? {}
    // Espelha os IDs externos nas colunas dedicadas (o resto do app lê delas).
    const patch: Record<string, unknown> = { provisioning_steps: persisted }
    if (stepName === 'github') {
      if (out.repoFullName) patch.github_repo_full_name = out.repoFullName
      if (out.repoId) patch.github_repo_id = out.repoId
      if (out.branch) {
        patch.default_branch = out.branch
        patch.active_branch = out.branch
      }
    }
    if (stepName === 'supabase') {
      if (out.supabaseProjectRef)
        patch.supabase_project_ref = out.supabaseProjectRef
      if (out.dbPasswordEncrypted)
        patch.db_password_encrypted = out.dbPasswordEncrypted
    }
    await supabase
      .from('projects')
      .update(patch)
      .eq('id', projectId)
      .eq('user_id', user.id)
  }

  const markFailed = async (stepName: string, error: string): Promise<void> => {
    await supabase
      .from('projects')
      .update({
        provisioning_state: 'failed',
        provisioning_error: `[${stepName}] ${error}`,
      })
      .eq('id', projectId)
      .eq('user_id', user.id)
  }

  const markReady = async (): Promise<void> => {
    // Projeto recém-provisionado vira o ativo (senão o MCP diz "nenhum ativo").
    await supabase
      .from('projects')
      .update({ is_active: false })
      .eq('user_id', user.id)
      .neq('id', projectId)
    await supabase
      .from('projects')
      .update({
        is_active: true,
        template_version: TEMPLATE_VERSION,
        capabilities,
        security_profile: securityProfile,
        scaffold_version: TEMPLATE_VERSION,
        security_baseline_version: SECURITY_BASELINE_VERSION,
        provisioning_state: 'ready',
        provisioning_error: null,
        status: 'active',
      })
      .eq('id', projectId)
      .eq('user_id', user.id)

    await supabase.from('audit_logs').insert({
      user_id: user.id,
      action: 'project.scaffold',
      resource_type: 'project',
      resource_id: projectId,
      metadata: {
        repo: persisted.github?.output?.repoFullName ?? null,
        commit: persisted.scaffold?.output?.commitSha ?? null,
        supabase_ref: persisted.supabase?.output?.supabaseProjectRef ?? null,
        template_version: TEMPLATE_VERSION,
        capabilities,
        files: files.length,
      },
      ip_address: null,
    })
    revalidatePath('/', 'layout')
  }

  // ── Passos (ordem = estados: provisioning → scaffolding → validating) ──────
  const steps: StepDef<ScaffoldCtx>[] = [
    {
      name: 'github',
      state: 'provisioning',
      run: async (ctx, persist) => {
        // Reuso: se o repo já foi criado (persistido), NÃO recria — só reobtém
        // o SHA base. Nunca tratamos 422 como fluxo normal.
        if (ctx.repoFullName) {
          const branch = (ctx.branch as string) || 'main'
          const baseSha = await waitForBranch(
            ctx.repoFullName as string,
            branch,
            githubToken,
          )
          if (!baseSha) throw new Error('A branch inicial não apareceu.')
          return {
            repoFullName: ctx.repoFullName,
            repoId: ctx.repoId,
            branch,
            baseSha,
          }
        }
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
            throw new Error(`O repositório "${name}" já existe na sua conta GitHub.`)
          }
          const detail = (await repoResponse.json()) as { message?: string }
          throw new Error(
            `Erro ao criar repositório: ${detail.message ?? repoResponse.status}`,
          )
        }
        const repo = (await repoResponse.json()) as GithubRepo
        const branch = repo.default_branch || 'main'
        // Persiste o ID externo ASSIM QUE existe (antes de avançar/esperar).
        await persist({ repoFullName: repo.full_name, repoId: repo.id, branch })
        const baseSha = await waitForBranch(repo.full_name, branch, githubToken)
        if (!baseSha) {
          throw new Error('O repositório foi criado mas a branch inicial não apareceu.')
        }
        return { repoFullName: repo.full_name, repoId: repo.id, branch, baseSha }
      },
    },
    {
      name: 'supabase',
      state: 'provisioning',
      run: async (ctx, persist) => {
        if (!supabaseAccountId) {
          warnings.push(
            'Nenhuma conta Supabase vinculada — o projeto foi criado sem banco.',
          )
          return { supabaseSkipped: true }
        }
        const provisioned = await provisionSupabase(
          supabase,
          user.id,
          supabaseAccountId,
          name,
          files,
          {
            existingRef: ctx.supabaseProjectRef as string | undefined,
            existingPasswordEncrypted:
              (ctx.dbPasswordEncrypted as string | undefined) ?? null,
            // Persiste o ref do projeto Supabase assim que criado (antes de migrar).
            onProjectCreated: async (ref, enc) => {
              await persist({ supabaseProjectRef: ref, dbPasswordEncrypted: enc })
            },
          },
        )
        warnings.push(...provisioned.warnings)
        return {
          supabaseProjectRef: provisioned.projectRef,
          dbPasswordEncrypted: provisioned.dbPasswordEncrypted,
        }
      },
    },
    {
      name: 'scaffold',
      state: 'scaffolding',
      run: async (ctx) => {
        const commitSha = await commitTemplate(
          ctx.repoFullName as string,
          ctx.branch as string,
          ctx.baseSha as string,
          githubToken,
          files,
        )
        return { commitSha }
      },
    },
    {
      name: 'protection',
      state: 'scaffolding',
      run: async (ctx) => {
        const protectionError = await protectBranch(
          ctx.repoFullName as string,
          ctx.branch as string,
          githubToken,
        )
        if (protectionError) warnings.push(protectionError)
        const scanningError = await enableCodeScanning(
          ctx.repoFullName as string,
          githubToken,
        )
        if (scanningError) warnings.push(scanningError)
        return {}
      },
    },
    {
      name: 'validation',
      state: 'validating',
      run: async (ctx) => {
        // Baseline de provisioning: o commit do scaffold está de fato no HEAD?
        const head = await getBranchHead(
          ctx.repoFullName as string,
          ctx.branch as string,
          githubToken,
        )
        if (!head) throw new Error('Não consegui ler o HEAD da branch.')
        if (ctx.commitSha && head !== ctx.commitSha) {
          throw new Error('O commit do scaffold não está no HEAD da branch.')
        }
        return { validated: true }
      },
    },
  ]

  const result = await runProvisioning(
    steps,
    persisted,
    { setState, persistStep, markReady, markFailed },
    {},
  )

  if (result.ok) return warnings.length > 0 ? { warnings } : {}
  return { error: result.error ?? 'Falha no provisioning.' }
}

// ─────────────────────────────────────────────────────────────

async function waitForBranch(
  repoFullName: string,
  branch: string,
  token: string,
): Promise<string | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await githubFetch(
      `/repos/${repoFullName}/git/ref/heads/${branch}`,
      token,
    )

    if (response.ok) {
      const data = (await response.json()) as { object: { sha: string } }
      return data.object.sha
    }

    await sleep(1000 * (attempt + 1))
  }
  return null
}

/** Lê o SHA do HEAD da branch (uma vez, sem polling) — usado na validação. */
async function getBranchHead(
  repoFullName: string,
  branch: string,
  token: string,
): Promise<string | null> {
  const response = await githubFetch(
    `/repos/${repoFullName}/git/ref/heads/${branch}`,
    token,
  )
  if (!response.ok) return null
  const data = (await response.json()) as { object: { sha: string } }
  return data.object.sha
}

async function commitTemplate(
  repoFullName: string,
  branch: string,
  baseSha: string,
  token: string,
  files: FileEntry[],
): Promise<string> {
  const baseCommitResponse = await githubFetch(
    `/repos/${repoFullName}/git/commits/${baseSha}`,
    token,
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
    },
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
    },
  )

  if (!commitResponse.ok) {
    throw new Error('Erro ao criar o commit inicial.')
  }

  const commit = (await commitResponse.json()) as { sha: string }

  const refResponse = await githubFetch(
    `/repos/${repoFullName}/git/refs/heads/${branch}`,
    token,
    {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha, force: false }),
    },
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
  files: FileEntry[],
  opts: {
    /** Ref de um projeto Supabase já criado (retry) — reutiliza, não recria. */
    existingRef?: string | undefined
    existingPasswordEncrypted?: string | null | undefined
    /** Chamado assim que o projeto é criado, para persistir o ref na hora. */
    onProjectCreated?: (
      ref: string,
      passwordEncrypted: string,
    ) => Promise<void>
  } = {},
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
      projectRef: opts.existingRef ?? null,
      dbPasswordEncrypted: opts.existingPasswordEncrypted ?? null,
      warnings: ['Conta Supabase não encontrada.'],
    }
  }

  const token = decryptToken(account.access_token_encrypted as string)

  // Reuso idempotente: se já existe um ref (retry), NÃO cria outro projeto.
  let ref = opts.existingRef ?? null
  let dbPasswordEncrypted = opts.existingPasswordEncrypted ?? null

  if (!ref) {
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

    const orgs = (await orgsResponse.json()) as Array<{
      id: string
      slug: string
    }>
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
      throw new Error(`Falha ao criar projeto Supabase: ${detail.slice(0, 160)}`)
    }

    const created = (await createResponse.json()) as { ref: string }
    ref = created.ref
    dbPasswordEncrypted = encryptToken(dbPassword)
    // Persiste o ref IMEDIATAMENTE — se algo falhar depois, o retry reusa.
    if (opts.onProjectCreated) {
      await opts.onProjectCreated(ref, dbPasswordEncrypted)
    }
  }

  const ready = await waitForSupabaseProject(ref, token)

  if (!ready) {
    warnings.push(
      'O banco Supabase ainda estava provisionando. Aplique a migration inicial ' +
        'pelo painel ou rode a ferramenta apply_migration quando ele ficar pronto.',
    )
    return { projectRef: ref, dbPasswordEncrypted, warnings }
  }

  // A mesma migration versionada no repositório é a que roda aqui — repositório
  // e banco não divergem.
  const migration = files.find((file) =>
    file.path.startsWith('supabase/migrations/'),
  )

  if (migration) {
    const migrationResponse = await fetch(
      `${SUPABASE_API}/v1/projects/${ref}/database/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: migration.content }),
      },
    )

    if (!migrationResponse.ok) {
      const detail = await migrationResponse.text()
      warnings.push(
        `A migration inicial está versionada em ${migration.path} mas o banco ` +
          `a recusou: ${detail.slice(0, 160)}`,
      )
    }
  }

  return { projectRef: ref, dbPasswordEncrypted, warnings }
}

async function waitForSupabaseProject(
  projectRef: string,
  token: string,
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
  token: string,
): Promise<string | null> {
  const response = await githubFetch(
    `/repos/${repoFullName}/branches/${branch}/protection`,
    token,
    {
      method: 'PUT',
      body: JSON.stringify({
        // strict:false de propósito. strict exige a branch atualizada com o
        // main antes de mesclar, o que RE-RODA o CI toda vez que o main anda —
        // um custo enorme num fluxo de um dono/um agente em série, sem ganho
        // real (não há dois autores concorrentes). Os checks obrigatórios
        // continuam TODOS rodando e verdes; só não re-rodam à toa.
        required_status_checks: { strict: false, contexts: REQUIRED_CHECKS },
        enforce_admins: true,
        required_pull_request_reviews: null,
        restrictions: null,
        allow_force_pushes: false,
        allow_deletions: false,
      }),
    },
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
  token: string,
): Promise<string | null> {
  const response = await githubFetch(
    `/repos/${repoFullName}/code-scanning/default-setup`,
    token,
    {
      method: 'PUT',
      body: JSON.stringify({ state: 'configured', query_suite: 'extended' }),
    },
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
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
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
