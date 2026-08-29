import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import * as repo from './repository'
import * as gh from './github'
import { assertSafeSql } from './sql-guard'
import { mcpDataClient } from './tokens'

/**
 * Servidor MCP do Supremo, ligado a um usuário.
 *
 * Cada instância carrega a identidade resolvida do token. Nenhuma ferramenta
 * aceita um identificador de usuário vindo do cliente — o dono vem sempre
 * daqui, e o repositório filtra por ele em toda query.
 */

export const SERVER_INSTRUCTIONS = `Você está conectado ao Supremo, a plataforma que gerencia este projeto.

REGRAS INVIOLÁVEIS — valem em qualquer máquina, qualquer cliente, qualquer sessão:

1. Chame get_project_context ANTES de escrever qualquer código. Ele devolve o
   agents.md, o CLAUDE.md e o SECURITY.md do repositório. Essas são as regras
   do projeto e têm precedência sobre os seus padrões.

2. Você não commita na branch principal. propose_changes cria uma branch e abre
   um pull request. É o único caminho de escrita, e o servidor não expõe outro.

3. Depois de propor mudanças, chame wait_for_checks. Se falhar, chame
   get_failed_logs, corrija, e proponha de novo. Máximo de 3 tentativas antes
   de reportar ao usuário o que não conseguiu resolver.

4. Só merge_when_green fecha o ciclo, e ele recusa se algum gate estiver
   vermelho. Não tente contornar.

5. Toda tabela nova precisa de RLS, foreign keys explícitas, índice nas FKs e
   um teste que prove que outro usuário não lê aquela linha. apply_migration
   recusa DDL de tabela sem ENABLE ROW LEVEL SECURITY.

6. Nunca escreva segredo em código. Nunca valide no cliente o que decide acesso.
   Nunca confie em user_id vindo do corpo da requisição — use auth.uid().`

interface ToolContext {
  userId: string
}

type TextResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function ok(text: string): TextResult {
  return { content: [{ type: 'text', text }] }
}

function json(value: unknown): TextResult {
  return ok(JSON.stringify(value, null, 2))
}

function fail(error: unknown): TextResult {
  const message = error instanceof Error ? error.message : String(error)
  return { content: [{ type: 'text', text: `Erro: ${message}` }], isError: true }
}

/** Envolve o handler para que nenhuma exceção vaze como erro de protocolo. */
function guard<A>(
  handler: (args: A) => Promise<TextResult>
): (args: A) => Promise<TextResult> {
  return async (args: A) => {
    try {
      return await handler(args)
    } catch (error) {
      return fail(error)
    }
  }
}

const RULE_FILES = ['agents.md', 'AGENTS.md', 'CLAUDE.md', 'SECURITY.md']

export function createSupremoMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'supremo', version: '2.0.0' },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: SERVER_INSTRUCTIONS,
    }
  )

  // ───────────────────────────────────────────────────────────
  // Contexto
  // ───────────────────────────────────────────────────────────

  server.registerTool(
    'get_project_context',
    {
      title: 'Contexto do projeto',
      description:
        'Devolve o projeto ativo com as regras reais do repositório (agents.md, ' +
        'CLAUDE.md, SECURITY.md) e o estado do branch. Chame isto antes de escrever código.',
      inputSchema: {
        projectId: z
          .string()
          .uuid()
          .optional()
          .describe('Projeto alvo. Omitido, usa o projeto ativo.'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ projectId }) => {
      const project = await repo.resolveProject(ctx.userId, projectId)

      const context: Record<string, unknown> = {
        project: {
          id: project.id,
          name: project.name,
          description: project.description,
          repo: project.github_repo_full_name,
          branch: project.active_branch,
          defaultBranch: project.default_branch,
          supabaseRef: project.supabase_project_ref,
          status: project.status,
          previewUrl: project.preview_url,
        },
        rules: {} as Record<string, string>,
      }

      // As regras vêm do repositório, não do disco local — é isso que faz o
      // agente seguir o projeto de qualquer máquina.
      try {
        const creds = await repo.getGithubCredentials(ctx.userId, project)
        const rules: Record<string, string> = {}

        for (const file of RULE_FILES) {
          try {
            rules[file] = await gh.readFile(creds, file, project.default_branch)
          } catch {
            // Arquivo ausente é normal — nem todo repo tem os quatro.
          }
        }

        context.rules = rules
        context.headSha = await gh.getHeadSha(creds, project.active_branch)
      } catch (error) {
        context.rulesError =
          error instanceof Error ? error.message : String(error)
      }

      context.reminder = SERVER_INSTRUCTIONS
      return json(context)
    })
  )

  server.registerTool(
    'list_projects',
    {
      title: 'Listar projetos',
      description: 'Lista os seus projetos no Supremo.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async () => {
      const projects = await repo.listProjects(ctx.userId)
      return json(
        projects.map((p) => ({
          id: p.id,
          name: p.name,
          repo: p.github_repo_full_name,
          branch: p.active_branch,
          isActive: p.is_active,
          status: p.status,
        }))
      )
    })
  )

  server.registerTool(
    'switch_project',
    {
      title: 'Trocar projeto ativo',
      description: 'Define qual projeto é o ativo para as próximas chamadas.',
      inputSchema: { projectId: z.string().uuid() },
    },
    guard(async ({ projectId }) => {
      const project = await repo.setActiveProject(ctx.userId, projectId)
      await repo.logAudit(
        ctx.userId,
        'mcp.switch_project',
        'project',
        projectId
      )
      return ok(`Projeto ativo agora é "${project.name}".`)
    })
  )

  // ───────────────────────────────────────────────────────────
  // Leitura de código
  // ───────────────────────────────────────────────────────────

  server.registerTool(
    'read_file',
    {
      title: 'Ler arquivo',
      description: 'Lê um arquivo do repositório do projeto.',
      inputSchema: {
        path: z.string().min(1).describe('Caminho, ex: src/app/page.tsx'),
        ref: z.string().optional().describe('Branch ou SHA. Padrão: branch ativo.'),
        projectId: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ path, ref, projectId }) => {
      const project = await repo.resolveProject(ctx.userId, projectId)
      const creds = await repo.getGithubCredentials(ctx.userId, project)
      return ok(await gh.readFile(creds, path, ref))
    })
  )

  server.registerTool(
    'list_files',
    {
      title: 'Listar arquivos',
      description: 'Lista os arquivos versionados do repositório.',
      inputSchema: {
        ref: z.string().optional(),
        projectId: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ ref, projectId }) => {
      const project = await repo.resolveProject(ctx.userId, projectId)
      const creds = await repo.getGithubCredentials(ctx.userId, project)
      const files = await gh.listTree(creds, ref)
      return ok(files.map((f) => f.path).join('\n'))
    })
  )

  // ───────────────────────────────────────────────────────────
  // Escrita — sempre via branch e PR
  // ───────────────────────────────────────────────────────────

  server.registerTool(
    'propose_changes',
    {
      title: 'Propor mudanças',
      description:
        'Cria uma branch, commita os arquivos e abre um pull request. Este é o ' +
        'ÚNICO caminho de escrita: não existe commit direto na branch principal. ' +
        'Depois disto, chame wait_for_checks.',
      inputSchema: {
        summary: z
          .string()
          .min(8)
          .describe('Resumo em uma linha, no formato de commit semântico.'),
        files: z
          .array(
            z.object({
              path: z.string().min(1),
              content: z
                .string()
                .nullable()
                .describe('Conteúdo completo do arquivo. null remove o arquivo.'),
            })
          )
          .min(1),
        body: z.string().optional().describe('Descrição do PR.'),
        branch: z
          .string()
          .optional()
          .describe('Nome da branch. Gerado a partir do resumo se omitido.'),
        projectId: z.string().uuid().optional(),
      },
    },
    guard(async ({ summary, files, body, branch, projectId }) => {
      const project = await repo.resolveProject(ctx.userId, projectId)
      const creds = await repo.getGithubCredentials(ctx.userId, project)

      const branchName = branch ?? slugToBranch(summary)
      await gh.ensureBranch(creds, branchName, project.default_branch)

      const commit = await gh.commitFiles(creds, branchName, summary, files)

      const pr = await gh.openOrUpdatePullRequest(
        creds,
        branchName,
        summary,
        body ??
          `Proposto via Supremo MCP.\n\nArquivos alterados:\n` +
            files.map((f) => `- \`${f.path}\``).join('\n'),
        project.default_branch
      )

      await repo.updateProject(ctx.userId, project.id, {
        active_branch: branchName,
      })

      const messageId = await repo.recordMessage(ctx.userId, {
        projectId: project.id,
        role: 'assistant',
        content: summary,
        branch: branchName,
        prNumber: pr.number,
        prUrl: pr.url,
        commitSha: commit.sha,
        commitMessage: summary,
        filesChanged: files.map((f) => ({
          path: f.path,
          status: f.content === null ? 'removed' : 'modified',
        })),
        pipelineStatus: 'pending',
        mcpUsed: 'supremo-remote',
      })

      await repo.logAudit(ctx.userId, 'mcp.propose_changes', 'project', project.id, {
        branch: branchName,
        pr: pr.number,
        files: files.length,
      })

      return json({
        branch: branchName,
        commit: commit.sha,
        pullRequest: { number: pr.number, url: pr.url },
        messageId,
        next: 'Chame wait_for_checks com este prNumber.',
      })
    })
  )

  // ───────────────────────────────────────────────────────────
  // Gates
  // ───────────────────────────────────────────────────────────

  server.registerTool(
    'get_checks',
    {
      title: 'Estado dos gates',
      description: 'Estado atual dos checks de CI para um pull request.',
      inputSchema: {
        prNumber: z.number().int().positive(),
        projectId: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ prNumber, projectId }) => {
      const project = await repo.resolveProject(ctx.userId, projectId)
      const creds = await repo.getGithubCredentials(ctx.userId, project)
      const pr = await gh.getPullRequest(creds, prNumber)
      return json(await gh.getChecks(creds, pr.headSha))
    })
  )

  server.registerTool(
    'wait_for_checks',
    {
      title: 'Esperar os gates',
      description:
        'Espera de verdade os checks de CI terminarem e devolve o resultado. ' +
        'Se falhar, chame get_failed_logs para ver o que quebrou.',
      inputSchema: {
        prNumber: z.number().int().positive(),
        timeoutSeconds: z.number().int().min(30).max(900).default(600),
        projectId: z.string().uuid().optional(),
      },
    },
    guard(async ({ prNumber, timeoutSeconds, projectId }) => {
      const project = await repo.resolveProject(ctx.userId, projectId)
      const creds = await repo.getGithubCredentials(ctx.userId, project)
      const pr = await gh.getPullRequest(creds, prNumber)

      const deadline = Date.now() + timeoutSeconds * 1000
      let result = await gh.getChecks(creds, pr.headSha)

      while (
        (result.state === 'pending' || result.total === 0) &&
        Date.now() < deadline
      ) {
        await sleep(10_000)
        result = await gh.getChecks(creds, pr.headSha)
      }

      const status =
        result.state === 'passed'
          ? 'passed'
          : result.state === 'failed'
            ? 'failed'
            : 'running'

      await markPipelineStatus(ctx.userId, project.id, prNumber, status)

      if (result.state === 'pending') {
        return json({
          ...result,
          note: `Ainda rodando depois de ${timeoutSeconds}s. Chame de novo para continuar esperando.`,
        })
      }

      return json({
        ...result,
        next:
          result.state === 'passed'
            ? 'Todos os gates verdes. Chame merge_when_green.'
            : 'Gate vermelho. Chame get_failed_logs, corrija e proponha de novo.',
      })
    })
  )

  server.registerTool(
    'get_failed_logs',
    {
      title: 'Logs da falha',
      description:
        'Saída dos jobs de CI que falharam, para você corrigir o erro real ' +
        'em vez de adivinhar.',
      inputSchema: {
        prNumber: z.number().int().positive(),
        projectId: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ prNumber, projectId }) => {
      const project = await repo.resolveProject(ctx.userId, projectId)
      const creds = await repo.getGithubCredentials(ctx.userId, project)
      const pr = await gh.getPullRequest(creds, prNumber)
      return ok(await gh.getFailedJobLogs(creds, pr.headSha))
    })
  )

  server.registerTool(
    'merge_when_green',
    {
      title: 'Merge com gates verdes',
      description:
        'Faz squash merge do PR na branch principal. Recusa se qualquer gate ' +
        'estiver vermelho ou ainda rodando.',
      inputSchema: {
        prNumber: z.number().int().positive(),
        projectId: z.string().uuid().optional(),
      },
    },
    guard(async ({ prNumber, projectId }) => {
      const project = await repo.resolveProject(ctx.userId, projectId)
      const creds = await repo.getGithubCredentials(ctx.userId, project)
      const pr = await gh.getPullRequest(creds, prNumber)
      const checks = await gh.getChecks(creds, pr.headSha)

      if (checks.state !== 'passed') {
        return fail(
          `Merge recusado: ${checks.failed} gate(s) vermelho(s), ` +
            `${checks.pending} ainda rodando. ` +
            `Corrija antes de tentar de novo.`
        )
      }

      const merged = await gh.mergePullRequest(creds, prNumber)

      await repo.updateProject(ctx.userId, project.id, {
        active_branch: project.default_branch,
      })
      await markPipelineStatus(ctx.userId, project.id, prNumber, 'passed', {
        merged_sha: merged.sha,
      })
      await repo.logAudit(ctx.userId, 'mcp.merge', 'project', project.id, {
        pr: prNumber,
        sha: merged.sha,
      })

      return ok(
        `PR #${prNumber} mergeado em ${project.default_branch} (${merged.sha.slice(0, 7)}). ` +
          `Todos os ${checks.total} gates passaram.`
      )
    })
  )

  // ───────────────────────────────────────────────────────────
  // Banco
  // ───────────────────────────────────────────────────────────

  server.registerTool(
    'execute_sql',
    {
      title: 'Consultar o banco',
      description:
        'Executa SQL de leitura no banco Supabase do projeto. Para mudanças de ' +
        'schema use apply_migration, que versiona a migration no repositório.',
      inputSchema: {
        query: z.string().min(1),
        projectId: z.string().uuid().optional(),
      },
    },
    guard(async ({ query, projectId }) => {
      const project = await repo.resolveProject(ctx.userId, projectId)
      const creds = await repo.getSupabaseCredentials(ctx.userId, project)

      assertSafeSql(query, { allowDdl: false })

      const response = await fetch(
        `https://api.supabase.com/v1/projects/${creds.projectRef}/database/query`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${creds.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query }),
        }
      )

      const payload: unknown = await response.json()
      if (!response.ok) {
        return fail(`Supabase recusou a query: ${JSON.stringify(payload)}`)
      }

      await repo.logAudit(ctx.userId, 'mcp.execute_sql', 'project', project.id)
      return json(payload)
    })
  )

  server.registerTool(
    'apply_migration',
    {
      title: 'Aplicar migration',
      description:
        'Versiona uma migration em supabase/migrations/ (via PR) e aplica no ' +
        'banco. Recusa CREATE TABLE sem ENABLE ROW LEVEL SECURITY.',
      inputSchema: {
        name: z
          .string()
          .regex(/^[a-z0-9_]+$/, 'Use apenas minúsculas, números e underscore.')
          .describe('Nome curto, ex: add_posts_table'),
        sql: z.string().min(1),
        projectId: z.string().uuid().optional(),
      },
    },
    guard(async ({ name, sql, projectId }) => {
      const project = await repo.resolveProject(ctx.userId, projectId)
      const supabaseCreds = await repo.getSupabaseCredentials(ctx.userId, project)
      const ghCreds = await repo.getGithubCredentials(ctx.userId, project)

      assertSafeSql(sql, { allowDdl: true })

      const stamp = new Date()
        .toISOString()
        .replace(/[-:T]/g, '')
        .slice(0, 14)
      const path = `supabase/migrations/${stamp}_${name}.sql`
      const branchName = `migration/${name}`

      await gh.ensureBranch(ghCreds, branchName, project.default_branch)
      await gh.commitFiles(ghCreds, branchName, `feat(db): ${name}`, [
        { path, content: sql },
      ])
      const pr = await gh.openOrUpdatePullRequest(
        ghCreds,
        branchName,
        `feat(db): ${name}`,
        `Migration versionada em \`${path}\`.\n\nAplicada no banco no momento da criação deste PR.`,
        project.default_branch
      )

      const response = await fetch(
        `https://api.supabase.com/v1/projects/${supabaseCreds.projectRef}/database/query`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${supabaseCreds.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: sql }),
        }
      )

      const payload: unknown = await response.json()
      if (!response.ok) {
        return fail(
          `Migration versionada em ${path} (PR #${pr.number}), mas o banco ` +
            `recusou: ${JSON.stringify(payload)}`
        )
      }

      await repo.logAudit(ctx.userId, 'mcp.apply_migration', 'project', project.id, {
        migration: path,
      })

      return json({
        migration: path,
        pullRequest: { number: pr.number, url: pr.url },
        applied: true,
        next: 'Escreva os testes de RLS desta tabela e proponha no mesmo PR.',
      })
    })
  )

  return server
}

// ─────────────────────────────────────────────────────────────

/**
 * Converte um resumo de commit em nome de branch.
 * Exportado para teste: a normalização tem casos de borda reais.
 */
export function slugToBranch(summary: string): string {
  const slug = summary
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^(feat|fix|chore|refactor|test|docs|security)(\([^)]*\))?:\s*/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')

  const suffix = Date.now().toString(36).slice(-4)
  return `supremo/${slug || 'change'}-${suffix}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function markPipelineStatus(
  userId: string,
  projectId: string,
  prNumber: number,
  status: 'pending' | 'running' | 'passed' | 'failed',
  extra?: Record<string, unknown>
): Promise<void> {
  // A mensagem do PR é a linha mais recente com este pr_number.
  const { error } = await mcpDataClient()
    .from('messages')
    .update({
      pipeline_status: status,
      ...(extra ? { pipeline_log: extra } : {}),
    })
    .eq('user_id', userId)
    .eq('project_id', projectId)
    .eq('pr_number', prNumber)

  if (error) {
    console.error(`[mcp] falha ao atualizar pipeline_status: ${error.message}`)
  }
}
