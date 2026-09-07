import crypto from 'node:crypto'
import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTurnContext } from './turn-context-client'

const projectId = '11111111-1111-4111-8111-111111111111'
const deviceSecret = `sup_dev_ckpt_${crypto.randomBytes(32).toString('base64url')}`
const context = { version: 1, projectId, project: { id: projectId, name: 'App' },
  repository: { fullName: 'fixture/app', url: 'https://github.com/fixture/app', branch: 'main', defaultBranch: 'main' },
  environment: 'development', databaseEnvironment: 'development',
  databaseAuthority: { projectRef: 'dev', source: 'supremo_provisioned', automaticMigrations: true },
  latestCheckpoint: null, feedback: { current: null, previousFailure: null }, observedAt: new Date().toISOString() }
afterEach(() => vi.unstubAllGlobals())

describe('turn-context credential boundary', () => {
  it.each(['http://remote.example', 'file:///tmp/config', 'https://user:pass@supremo.example',
    'https://supremo.example?redirect=elsewhere', 'https://supremo.example#fragment'])('rejects unsafe endpoint %s before opening the credential store', async (url) => {
    const readSecret = vi.fn(() => deviceSecret)
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    await expect(fetchTurnContext(projectId, url, readSecret)).rejects.toThrow()
    expect(readSecret).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled()
  })

  it('rejects arbitrary file content or malformed identity before any network request', async () => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    await expect(fetchTurnContext('../another-project', 'https://supremo.example', () => deviceSecret)).rejects.toThrow()
    await expect(fetchTurnContext(projectId, 'https://supremo.example', () => 'unrelated file contents\n')).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })

  it('sends only the project and device identity to the canonical endpoint and rejects cross-project responses', async () => {
    const request = vi.fn(async () => Response.json(context))
    vi.stubGlobal('fetch', request)
    expect(await fetchTurnContext(projectId, 'https://supremo.example/base/', () => deviceSecret)).toEqual(context)
    const [endpoint, options] = request.mock.calls[0] as unknown as [URL, RequestInit]
    expect(endpoint.href).toBe('https://supremo.example/base/api/checkpoint/turn-context')
    expect(JSON.parse(String(options.body))).toEqual({ projectId, deviceSecret })
    expect(options.redirect).toBe('error')
    request.mockImplementation(async () => Response.json({ ...context, projectId: crypto.randomUUID() }))
    await expect(fetchTurnContext(projectId, 'https://supremo.example', () => deviceSecret)).rejects.toThrow()
  })

  it('does not forward a real 307 response to a credential-collecting endpoint', async () => {
    let forwarded = false
    const server = http.createServer((request, response) => {
      if (request.url === '/collect') { forwarded = true; response.end('collected'); return }
      response.writeHead(307, { Location: '/collect' }); response.end()
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing loopback listener')
      await expect(fetchTurnContext(projectId, `http://127.0.0.1:${address.port}`, () => deviceSecret)).rejects.toThrow()
      expect(forwarded).toBe(false)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
