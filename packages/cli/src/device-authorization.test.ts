import { afterEach, describe, expect, it, vi } from 'vitest'
import { authorizeDevice } from './bootstrap'

vi.mock('./auth', () => ({ defaultAuthIO: {}, openBrowser: vi.fn(async () => true),
  ensureAuthorized: async (options: { authorize: () => Promise<void>; isAuthorized: () => boolean }) => {
    await options.authorize(); return options.isAuthorized()
  } }))
const PROJECT = '11111111-1111-4111-8111-111111111111'
const ISSUER = 'https://supremo.example.invalid'
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('browser reauthorization preserves the source of device authority', () => {
  it('uses the explicit issuer for both non-redirecting device exchanges and verifies the returned project', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const calls: { url: string; input: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(init.redirect).toBe('error')
      calls.push({ url, input: JSON.parse(String(init.body)) as Record<string, unknown> })
      return Response.json(url.endsWith('/start')
        ? { deviceCode: 'opaque-device-flow', userCode: 'code', verificationUriComplete: `${ISSUER}/authorize`, intervalSec: 0, expiresAt: new Date(Date.now() + 1000).toISOString() }
        : { status: 'ready', config: { project: { id: PROJECT }, daemon: { deviceSecret: 'issued-at-authorized-origin' } } })
    }))
    expect(await authorizeDevice(PROJECT, ISSUER)).toMatchObject({ project: { id: PROJECT } })
    expect(calls).toEqual([
      { url: `${ISSUER}/api/bootstrap/device/start`, input: { projectId: PROJECT } },
      { url: `${ISSUER}/api/bootstrap/device/token`, input: { deviceCode: 'opaque-device-flow' } },
    ])
  })
  it('refuses a verification page on a different origin before polling for credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ verificationUriComplete: 'https://attacker.example.invalid/authorize' })))
    await expect(authorizeDevice(PROJECT, ISSUER)).rejects.toThrow('Origem')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('refuses a credential returned for a different project', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/start')
      ? { deviceCode: 'opaque', verificationUriComplete: `${ISSUER}/authorize`, intervalSec: 0, expiresAt: new Date(Date.now() + 1000).toISOString() }
      : { status: 'ready', config: { project: { id: '22222222-2222-4222-8222-222222222222' } } })))
    await expect(authorizeDevice(PROJECT, ISSUER)).rejects.toThrow('Projeto autorizado diverge')
  })
})
