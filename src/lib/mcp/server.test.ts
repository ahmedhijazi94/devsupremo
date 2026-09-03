import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock das bordas: o teste prova a fiação de get_project_context sem tocar em
// rede. O que importa é que ele lista os PRs abertos e devolve inFlight com o
// estado do gate — a parte que faz "continuar de onde parou" existir.
vi.mock('./repository', () => ({
  resolveProject: vi.fn(async () => ({
    id: 'p1',
    name: 'app',
    description: null,
    github_repo_full_name: 'dono/app',
    active_branch: 'main',
    default_branch: 'main',
    supabase_project_ref: 'ref',
    status: 'active',
    preview_url: null,
  })),
  getGithubCredentials: vi.fn(async () => ({
    owner: 'dono',
    repo: 'app',
    token: 't',
  })),
  logAudit: vi.fn(async () => undefined),
  updateProject: vi.fn(async () => undefined),
}))

vi.mock('./github', () => ({
  readFile: vi.fn(async () => '# regra'),
  getHeadSha: vi.fn(async () => 'sha-main'),
  listOpenPullRequests: vi.fn(async () => [
    {
      number: 7,
      title: 'feat: carrinho',
      headRef: 'supremo/carrinho',
      headSha: 'sha7',
      url: 'https://github.com/dono/app/pull/7',
      updatedAt: '2026-01-01T00:00:00Z',
      isMigration: false,
      isAgentWork: true,
    },
    {
      number: 8,
      title: 'chore(deps): bump jsdom to 30',
      headRef: 'dependabot/npm_and_yarn/jsdom-30',
      headSha: 'sha8',
      url: 'https://github.com/dono/app/pull/8',
      updatedAt: '2026-01-02T00:00:00Z',
      isMigration: false,
      isAgentWork: false,
    },
  ]),
  getChecks: vi.fn(async () => ({
    state: 'failed',
    total: 7,
    passed: 5,
    failed: 1,
    pending: 1,
    checks: [],
    headSha: 'sha7',
  })),
  getPullRequest: vi.fn(async () => ({
    number: 7,
    url: 'https://github.com/dono/app/pull/7',
    headSha: 'sha7',
    headRef: 'supremo/carrinho',
    state: 'open',
    merged: false,
    mergeable: true,
    nodeId: 'PR_node7',
  })),
  mergePullRequest: vi.fn(async () => ({ sha: 'merged-sha' })),
}))

// mcpDataClient() (usado por markPipelineStatus dentro de merge_when_green)
// exige SUPABASE_URL/SERVICE_ROLE_KEY reais fora deste mock — aqui é só um
// stub encadeável (.from().update().eq()...) que resolve sem erro.
vi.mock('./tokens', () => {
  const chain: Record<string, unknown> = {}
  chain.from = () => chain
  chain.update = () => chain
  chain.eq = () => chain
  chain.then = (resolve: (v: { error: null }) => void) => resolve({ error: null })
  return { mcpDataClient: vi.fn(() => chain) }
})

import { createSupremoMcpServer } from './server'
import { slugToBranch, SERVER_INSTRUCTIONS, resumeAction } from './server'
import * as gh from './github'
import type { CheckSummary } from './github'
import { CI_JOB_NAMES } from '@/lib/templates/project-files'

/** Invoca uma tool registrada pelo caminho que a instância usa internamente. */
async function callTool(tool: string, args: Record<string, unknown> = {}) {
  const server = createSupremoMcpServer({ userId: 'u1' })
  // O SDK guarda as tools aqui; o handler é a própria callback quando há schema.
  const registered = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (a: unknown, e: unknown) => Promise<unknown> }
      >
    }
  )._registeredTools[tool]
  if (!registered) throw new Error(`tool ${tool} não registrada`)
  const result = (await registered.handler(args, {})) as {
    content: Array<{ text: string }>
  }
  return JSON.parse(result.content[0]!.text)
}

/**
 * Como `callTool`, mas devolve o TextResult cru (isError + texto) em vez de
 * assumir JSON. `fail(...)` (usado por merge_when_green ao recusar) devolve
 * um texto tipo "Erro: ..." — JSON.parse nele derruba `callTool` por
 * acidente (SyntaxError, não pelo motivo semântico). Para testar uma
 * RECUSA de verdade, isto é mais preciso: confirma `isError`/o texto, sem
 * depender de um efeito colateral de parsing.
 */
async function callToolRaw(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean | undefined; text: string }> {
  const server = createSupremoMcpServer({ userId: 'u1' })
  const registered = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }
      >
    }
  )._registeredTools[tool]
  if (!registered) throw new Error(`tool ${tool} não registrada`)
  const result = await registered.handler(args, {})
  return { isError: result.isError, text: result.content[0]!.text }
}

describe('slugToBranch', () => {
  it('usa o prefixo supremo/', () => {
    expect(slugToBranch('feat: adiciona login')).toMatch(/^supremo\//)
  })

  it('remove o prefixo de commit semântico', () => {
    expect(slugToBranch('feat: adiciona login')).toContain('adiciona-login')
    expect(slugToBranch('fix(auth): corrige sessão')).toContain(
      'corrige-sessao',
    )
  })

  it('remove acentos', () => {
    expect(slugToBranch('feat: configuração de opção')).toContain(
      'configuracao-de-opcao',
    )
  })

  it('não deixa caractere inválido para ref do git', () => {
    const branch = slugToBranch('feat: usuário & senha (v2)! 100%')
    expect(branch).toMatch(/^supremo\/[a-z0-9-]+$/)
  })

  it('não termina com hífen', () => {
    expect(slugToBranch('feat: teste ---')).not.toMatch(/-$/)
  })

  it('trunca resumo longo mas mantém a branch utilizável', () => {
    const branch = slugToBranch(`feat: ${'palavra '.repeat(30)}`)
    expect(branch.length).toBeLessThan(60)
    expect(branch).toMatch(/^supremo\/[a-z0-9-]+$/)
  })

  it('gera nomes diferentes para o mesmo resumo', async () => {
    const first = slugToBranch('feat: mesmo texto')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = slugToBranch('feat: mesmo texto')
    expect(first).not.toBe(second)
  })

  it('sobrevive a resumo sem nenhum caractere aproveitável', () => {
    expect(slugToBranch('!!!! ####')).toMatch(/^supremo\/change-/)
  })
})

describe('SERVER_INSTRUCTIONS', () => {
  // As regras viajam no handshake do MCP. Se alguma sumir daqui, o agente
  // deixa de recebê-la em toda máquina conectada.
  it.each([
    ['get_project_context', 'ler as regras do projeto'],
    ['propose_changes', 'único caminho de escrita'],
    ['wait_for_checks', 'esperar os gates'],
    ['merge_when_green', 'fechar o ciclo'],
    ['ENABLE ROW LEVEL SECURITY', 'exigir RLS'],
    ['auth.uid()', 'não confiar no cliente'],
    ['get_preview_errors', 'confirmar que a aplicação sobe'],
  ])('menciona %s (%s)', (needle) => {
    expect(SERVER_INSTRUCTIONS).toContain(needle)
  })

  it('deixa explícito que não se commita na branch principal', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/não commita na branch principal/i)
  })

  it('separa gate verde de aplicação que abre', () => {
    // São coisas diferentes, e confundir as duas foi o que fez o preview
    // ficar em branco sem ninguém perceber.
    expect(SERVER_INSTRUCTIONS).toMatch(/não que a aplicação abre/i)
  })

  it('manda retomar o trabalho em andamento antes de abrir coisa nova', () => {
    // "Continuar de onde parou": sem esta ordem, o agente que conecta de outra
    // máquina abre um PR paralelo para algo que já estava em andamento.
    expect(SERVER_INSTRUCTIONS).toContain('inFlight')
    expect(SERVER_INSTRUCTIONS).toMatch(/RETOME/i)
  })
})

describe('resumeAction', () => {
  // O que faz "continuar de onde parou" ser acionável: quem retoma um PR sabe
  // exatamente o que fazer a partir do estado do gate, sem deduzir.
  it('vermelho manda corrigir no mesmo branch', () => {
    expect(resumeAction('failed')).toMatch(/get_failed_logs/)
    expect(resumeAction('failed')).toMatch(/mesmo branch/)
  })

  it('rodando manda esperar antes de mexer', () => {
    expect(resumeAction('pending')).toMatch(/wait_for_checks/)
  })

  it('verde manda fechar', () => {
    expect(resumeAction('passed')).toMatch(/merge_when_green/)
  })

  it('cobre os três estados que getChecks devolve', () => {
    const states = ['passed', 'failed', 'pending'] as const
    for (const state of states) {
      expect(resumeAction(state).length).toBeGreaterThan(0)
    }
  })
})

describe('get_project_context — continuar de onde parou', () => {
  beforeEach(() => vi.clearAllMocks())

  it('devolve as regras do repositório junto do estado', async () => {
    const context = await callTool('get_project_context')
    // As regras vêm do repo, não do disco: é o que faz o agente seguir o
    // projeto de qualquer máquina.
    expect(context.rules['agents.md']).toBe('# regra')
    expect(context.project.repo).toBe('dono/app')
  })

  it('inclui só o trabalho de agente como inFlight, com gate e ação', async () => {
    const context = await callTool('get_project_context')

    // Apenas o PR de branch supremo/ é "trabalho a retomar".
    expect(context.inFlight).toHaveLength(1)
    const pending = context.inFlight[0]
    expect(pending.pr).toBe(7)
    expect(pending.branch).toBe('supremo/carrinho')
    expect(pending.gate).toBe('failed')
    expect(pending.action).toMatch(/get_failed_logs/)
    expect(pending.gateDetail).toContain('5/7')
  })

  it('não trata PR de Dependabot como trabalho a retomar', async () => {
    // O bug real da natureza: o agente ficava preso mesclando bump de
    // dependência em vez de fazer a feature do usuário.
    const context = await callTool('get_project_context')

    expect(context.inFlight.map((p: { pr: number }) => p.pr)).not.toContain(8)

    expect(context.otherOpenPrs).toHaveLength(1)
    const dep = context.otherOpenPrs[0]
    expect(dep.pr).toBe(8)
    expect(dep.note).toMatch(/não bloqueie|não mescle/i)
  })
})

/**
 * E2E real: o workflow da PR do checkpoint ficou vermelho, mas o checkpoint
 * mesmo assim chegou à main. Causa raiz: `merge_when_green` decidia com o
 * agregado `ChecksResult.state` (`getChecks` em `mcp/github.ts`) — que só
 * conta 'failure'/'timed_out'/'cancelled' como reprovação e NUNCA compara
 * contra a lista de required checks — em vez do `evaluateMergeEligibility`
 * fail-closed já usado pelo Merge Controller assíncrono (webhook/fallback).
 * Um required check 'skipped', ou que nunca chegou a rodar (ausente), podia
 * passar. Estes testes provam que `merge_when_green` agora usa o MESMO gate
 * fail-closed, no HEAD exato da PR.
 */
describe('merge_when_green — gate fail-closed no HEAD exato (bug real: vermelho/pulado/faltando mesclava)', () => {
  beforeEach(() => vi.clearAllMocks())

  function allGreenChecks(): CheckSummary[] {
    return CI_JOB_NAMES.map((name) => ({
      name,
      status: 'completed',
      conclusion: 'success',
      url: null,
      runId: null,
    }))
  }

  it('todos os required checks success no HEAD exato → mescla', async () => {
    vi.mocked(gh.getChecks).mockResolvedValueOnce({
      state: 'passed',
      total: CI_JOB_NAMES.length,
      passed: CI_JOB_NAMES.length,
      failed: 0,
      pending: 0,
      checks: allGreenChecks(),
      headSha: 'sha7',
    })

    // merge_when_green devolve texto solto (ok(...)), não JSON — callTool
    // (que assume JSON) não serve aqui.
    const result = await callToolRaw('merge_when_green', { prNumber: 7 })

    expect(gh.mergePullRequest).toHaveBeenCalledWith(
      expect.anything(),
      7,
      undefined,
      'sha7',
    )
    expect(result.isError).toBeFalsy()
    expect(result.text).toMatch(/mergeado/i)
    expect(result.text).not.toMatch(/recusad/i)
  })

  it('um required check com conclusão "skipped" → RECUSA (bug real: o agregado antigo não contava skipped como falha)', async () => {
    const checks = allGreenChecks()
    const idx = checks.findIndex((c) => c.name === 'Políticas RLS')
    checks[idx] = { ...checks[idx]!, conclusion: 'skipped' }

    // O agregado antigo (getChecks().state) classificaria isto como 'passed'
    // — nenhum check tem conclusion failure/timed_out/cancelled, e nenhum
    // está pending. O NOVO gate (evaluateMergeEligibility) tem que recusar.
    vi.mocked(gh.getChecks).mockResolvedValueOnce({
      state: 'passed',
      total: CI_JOB_NAMES.length,
      passed: CI_JOB_NAMES.length,
      failed: 0,
      pending: 0,
      checks,
      headSha: 'sha7',
    })

    const result = await callToolRaw('merge_when_green', { prNumber: 7 })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/recusad/i)
    expect(result.text).toMatch(/Políticas RLS/)
    expect(gh.mergePullRequest).not.toHaveBeenCalled()
  })

  it('um required check AUSENTE (nunca rodou) → RECUSA (bug real: o agregado antigo não comparava contra a lista de required checks)', async () => {
    // 'End-to-end' nunca aparece na resposta do GitHub — nem sucesso, nem
    // falha, nem pending: simplesmente não existe pra este HEAD.
    const checks = allGreenChecks().filter((c) => c.name !== 'End-to-end')

    vi.mocked(gh.getChecks).mockResolvedValueOnce({
      state: 'passed',
      total: checks.length,
      passed: checks.length,
      failed: 0,
      pending: 0,
      checks,
      headSha: 'sha7',
    })

    const result = await callToolRaw('merge_when_green', { prNumber: 7 })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/recusad/i)
    expect(result.text).toMatch(/End-to-end/)
    expect(gh.mergePullRequest).not.toHaveBeenCalled()
  })

  it('um required check ainda "in_progress" (rodando) → RECUSA, nunca mescla parcial', async () => {
    const checks = allGreenChecks()
    const idx = checks.findIndex((c) => c.name === 'Build de produção')
    checks[idx] = { ...checks[idx]!, status: 'in_progress' as const, conclusion: null }

    vi.mocked(gh.getChecks).mockResolvedValueOnce({
      state: 'pending',
      total: CI_JOB_NAMES.length,
      passed: CI_JOB_NAMES.length - 1,
      failed: 0,
      pending: 1,
      checks,
      headSha: 'sha7',
    })

    const result = await callToolRaw('merge_when_green', { prNumber: 7 })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/recusad/i)
    expect(gh.mergePullRequest).not.toHaveBeenCalled()
  })

  it('checks pertencem a um SHA diferente do HEAD atual da PR → RECUSA (anti-TOCTOU, HEAD exato preservado)', async () => {
    // pr.headSha (mock padrão) é 'sha7' — os checks aqui são de um SHA velho.
    vi.mocked(gh.getChecks).mockResolvedValueOnce({
      state: 'passed',
      total: CI_JOB_NAMES.length,
      passed: CI_JOB_NAMES.length,
      failed: 0,
      pending: 0,
      checks: allGreenChecks(),
      headSha: 'sha-velho-antes-do-ultimo-push',
    })

    const result = await callToolRaw('merge_when_green', { prNumber: 7 })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/recusad/i)
    expect(gh.mergePullRequest).not.toHaveBeenCalled()
  })
})
