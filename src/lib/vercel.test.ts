import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  describeState,
  listDeployments,
  identify,
  deployFiles,
  VercelError,
} from './vercel'

describe('describeState', () => {
  it.each([
    ['READY', 'No ar', 'ok'],
    ['ERROR', 'Falhou', 'error'],
    ['CANCELED', 'Cancelado', 'error'],
    ['BUILDING', 'Publicando', 'working'],
    ['QUEUED', 'Publicando', 'working'],
    ['INITIALIZING', 'Publicando', 'working'],
  ] as const)('%s vira "%s" (%s)', (state, label, tone) => {
    expect(describeState(state)).toEqual({ label, tone })
  })
})

describe('listDeployments', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  function respond(body: unknown, ok = true, status = 200) {
    fetchMock.mockResolvedValue({
      ok,
      status,
      text: async () => JSON.stringify(body),
    })
  }

  it('normaliza a URL sem protocolo', async () => {
    respond({
      deployments: [
        { uid: 'a', url: 'app.vercel.app', created: 1, readyState: 'READY' },
      ],
    })
    const [deployment] = await listDeployments('t', null, 'p')
    expect(deployment?.url).toBe('https://app.vercel.app')
  })

  it('preserva URL que já vem com protocolo', async () => {
    respond({
      deployments: [
        {
          uid: 'a',
          url: 'https://app.vercel.app',
          created: 1,
          readyState: 'READY',
        },
      ],
    })
    const [deployment] = await listDeployments('t', null, 'p')
    expect(deployment?.url).toBe('https://app.vercel.app')
  })

  it('usa readyState quando presente, senão state', async () => {
    respond({
      deployments: [
        { uid: 'a', url: 'a.app', created: 2, readyState: 'BUILDING' },
        { uid: 'b', url: 'b.app', created: 1, state: 'ERROR' },
      ],
    })
    const deployments = await listDeployments('t', null, 'p')
    expect(deployments.map((d) => d.state)).toEqual(['BUILDING', 'ERROR'])
  })

  it('sem nenhum dos dois, assume que está na fila', async () => {
    respond({ deployments: [{ uid: 'a', url: 'a.app', created: 1 }] })
    const [deployment] = await listDeployments('t', null, 'p')
    expect(deployment?.state).toBe('QUEUED')
  })

  it('filtra por branch quando pedido', async () => {
    respond({
      deployments: [
        {
          uid: 'a',
          url: 'a.app',
          created: 2,
          meta: { githubCommitRef: 'main' },
        },
        {
          uid: 'b',
          url: 'b.app',
          created: 1,
          meta: { githubCommitRef: 'feat/x' },
        },
      ],
    })
    const deployments = await listDeployments('t', null, 'p', {
      branch: 'feat/x',
    })
    expect(deployments.map((d) => d.id)).toEqual(['b'])
  })

  it('lista vazia não quebra', async () => {
    respond({})
    expect(await listDeployments('t', null, 'p')).toEqual([])
  })

  it('inclui o teamId na query quando há time', async () => {
    respond({ deployments: [] })
    await listDeployments('t', 'team_123', 'p')
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('teamId=team_123')
  })

  it('omite o teamId em conta pessoal', async () => {
    respond({ deployments: [] })
    await listDeployments('t', null, 'p')
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('teamId')
  })

  it('erro da API vira VercelError com a mensagem da Vercel', async () => {
    respond({ error: { message: 'Not authorized' } }, false, 403)
    await expect(listDeployments('t', null, 'p')).rejects.toThrow(VercelError)
    await expect(listDeployments('t', null, 'p')).rejects.toThrow(
      'Not authorized',
    )
  })
})

describe('identify', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('prefere o time quando o token tem um', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ teams: [{ id: 'team_1', name: 'Ahmed' }] }),
    })
    expect(await identify('t')).toEqual({
      accountName: 'Ahmed',
      teamId: 'team_1',
    })
  })

  it('cai na conta pessoal quando não há time', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ teams: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ user: { username: 'ahmed', name: 'Ahmed H' } }),
      })

    expect(await identify('t')).toEqual({
      accountName: 'Ahmed H',
      teamId: null,
    })
  })

  it('usa o username quando não há nome', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ teams: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ user: { username: 'ahmed' } }),
      })

    expect((await identify('t')).accountName).toBe('ahmed')
  })
})

describe('deployFiles', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('não envia target — a Vercel recusa "preview" no /v13/deployments', async () => {
    // Bug real: enviar target:'preview' devolvia "Invalid request: target
    // should be production, staging, or a custom environment identifier", e o
    // preview nunca subia. Sem target, a Vercel cria um deploy de preview.
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/v2/files')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({}) }
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            uid: 'd1',
            url: 'app.vercel.app',
            created: 1,
            readyState: 'READY',
          }),
      }
    })

    await deployFiles('t', null, 'proj', [
      { path: 'index.html', content: '<x>' },
    ])

    const deployCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes('/v13/deployments'),
    )
    expect(deployCall, 'deveria ter chamado /v13/deployments').toBeTruthy()
    const body = JSON.parse((deployCall![1] as { body: string }).body)
    expect(body).not.toHaveProperty('target')
  })
})
