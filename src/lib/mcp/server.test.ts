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
}))

import { createSupremoMcpServer } from './server'
import { slugToBranch, SERVER_INSTRUCTIONS, resumeAction } from './server'

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

  it('inclui o trabalho em andamento com o estado do gate e a ação', async () => {
    const context = await callTool('get_project_context')

    expect(context.inFlight).toHaveLength(1)
    const pending = context.inFlight[0]
    expect(pending.pr).toBe(7)
    expect(pending.branch).toBe('supremo/carrinho')
    expect(pending.gate).toBe('failed')
    // Um PR vermelho tem que dizer ao próximo agente para corrigir, não abrir
    // outro PR paralelo.
    expect(pending.action).toMatch(/get_failed_logs/)
    expect(pending.gateDetail).toContain('5/7')
  })
})
