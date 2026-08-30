import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Testes do endpoint MCP remoto.
 *
 * Exercitam o route handler de verdade — protocolo, autenticação e o
 * anúncio das ferramentas. A resolução do token é a única coisa dublada,
 * porque depende do banco.
 */

const resolveMcpToken = vi.fn()

vi.mock('@/lib/mcp/tokens', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/mcp/tokens')>('@/lib/mcp/tokens')
  return {
    ...actual,
    resolveMcpToken: (token: string) => resolveMcpToken(token),
    mcpDataClient: () => {
      throw new Error('Nenhuma ferramenta deveria tocar o banco nestes testes.')
    },
  }
})

const { POST } = await import('./route')

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'teste', version: '1.0.0' },
  },
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

const authorized = { Authorization: 'Bearer sup_token-valido' }

beforeEach(() => {
  resolveMcpToken.mockReset()
  resolveMcpToken.mockResolvedValue({
    userId: '11111111-1111-4111-8111-111111111111',
    tokenId: '22222222-2222-4222-8222-222222222222',
  })
})

describe('autenticação', () => {
  it('recusa sem header Authorization', async () => {
    const response = await POST(request(INITIALIZE))

    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toContain('Bearer')
    expect(resolveMcpToken).not.toHaveBeenCalled()
  })

  it('recusa token que não é do Supremo sem consultar o banco', async () => {
    const response = await POST(
      request(INITIALIZE, { Authorization: 'Bearer ghp_doGithub' }),
    )

    expect(response.status).toBe(401)
    // Um token de outro provedor nem chega ao banco.
    expect(resolveMcpToken).not.toHaveBeenCalled()
  })

  it('recusa token revogado ou inexistente', async () => {
    resolveMcpToken.mockResolvedValue(null)

    const response = await POST(request(INITIALIZE, authorized))
    const body = (await response.json()) as { error: { message: string } }

    expect(response.status).toBe(401)
    expect(body.error.message).toMatch(/revogado ou expirado/i)
  })

  it('nunca devolve o token na resposta', async () => {
    resolveMcpToken.mockResolvedValue(null)

    const response = await POST(request(INITIALIZE, authorized))
    expect(await response.text()).not.toContain('sup_token-valido')
  })

  it('responde no-store para não cachear resposta autenticada', async () => {
    const response = await POST(request(INITIALIZE))
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('protocolo MCP', () => {
  it('completa o handshake de initialize', async () => {
    const response = await POST(request(INITIALIZE, authorized))
    const body = (await response.json()) as {
      result: {
        serverInfo: { name: string }
        instructions: string
        capabilities: Record<string, unknown>
      }
    }

    expect(response.status).toBe(200)
    expect(body.result.serverInfo.name).toBe('supremo')
    expect(body.result.capabilities).toHaveProperty('tools')
  })

  it('entrega as regras invioláveis já no handshake', async () => {
    const response = await POST(request(INITIALIZE, authorized))
    const body = (await response.json()) as {
      result: { instructions: string }
    }

    // É isto que faz as regras valerem em qualquer máquina, antes da
    // primeira chamada de ferramenta.
    expect(body.result.instructions).toContain('get_project_context')
    expect(body.result.instructions).toMatch(/não commita na branch principal/i)
    expect(body.result.instructions).toContain('merge_when_green')
  })

  it('resolve a identidade a partir do token recebido', async () => {
    await POST(request(INITIALIZE, authorized))
    expect(resolveMcpToken).toHaveBeenCalledWith('sup_token-valido')
  })
})

describe('ferramentas anunciadas', () => {
  async function listTools(): Promise<string[]> {
    const response = await POST(
      request(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        },
        authorized,
      ),
    )

    const body = (await response.json()) as {
      result?: { tools: Array<{ name: string }> }
    }
    return (body.result?.tools ?? []).map((tool) => tool.name)
  }

  it('expõe o conjunto esperado', async () => {
    const tools = await listTools()

    expect(tools).toEqual(
      expect.arrayContaining([
        'get_project_context',
        'list_projects',
        'switch_project',
        'read_file',
        'list_files',
        'propose_changes',
        'get_checks',
        'wait_for_checks',
        'get_failed_logs',
        'merge_when_green',
        'execute_sql',
        'apply_migration',
        'get_preview_errors',
      ]),
    )
  })

  it('não expõe nenhuma escrita direta na branch principal', async () => {
    const tools = await listTools()

    // propose_changes é o único caminho de escrita, e ele abre PR.
    // Se alguma ferramenta de commit direto reaparecer, o gate deixa de
    // ser obrigatório.
    expect(tools).not.toContain('write_github_files')
    expect(tools).not.toContain('commit_and_deploy')
    expect(tools).not.toContain('push')
  })

  it('nenhuma ferramenta aceita userId vindo do cliente', async () => {
    const response = await POST(
      request(
        { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
        authorized,
      ),
    )

    const body = (await response.json()) as {
      result?: {
        tools: Array<{
          inputSchema?: { properties?: Record<string, unknown> }
        }>
      }
    }

    for (const tool of body.result?.tools ?? []) {
      const properties = Object.keys(tool.inputSchema?.properties ?? {})
      expect(properties).not.toContain('userId')
      expect(properties).not.toContain('user_id')
    }
  })
})
