import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn() }))
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser: mocks.user } }) }))

let proxy: typeof import('./proxy').proxy
const request = (method = 'POST', path = '/projects/example/backend', action = true) => new NextRequest(`https://supremo.example${path}`, {
  method, headers: { ...(action ? { 'next-action': 'fixture-action' } : {}), 'x-forwarded-for': '192.0.2.1' },
})

beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks()
  mocks.user.mockResolvedValue({ data: { user: { id: 'owner-1' } } })
  proxy = (await import('./proxy')).proxy
})
afterEach(() => vi.restoreAllMocks())

describe('proxy Server Action rate limits', () => {
  it('allows 60 actions per owner and refuses the next action independently of the path', async () => {
    for (let i = 0; i < 60; i++) expect((await proxy(request())).status).toBe(200)
    const refused = await proxy(request('POST', '/projects/other/backend'))
    expect(refused.status).toBe(429)
    expect(await refused.text()).toBe('Too Many Requests')
  })

  it('counts form POSTs without next-action and actions outside protected paths in the same quota', async () => {
    for (let i = 0; i < 30; i++) expect((await proxy(request('POST', '/projects/example/backend', false))).status).toBe(200)
    for (let i = 0; i < 30; i++) expect((await proxy(request('POST', '/public-page', false))).status).toBe(200)
    expect((await proxy(request('POST', '/public-page'))).status).toBe(429)
    expect((await proxy(request('POST', '/projects/example/backend', false))).status).toBe(429)
    expect((await proxy(request('POST', '/api/example', false))).status).toBe(200)
  })

  it('does not consume or block normal page GETs when the action quota is exhausted', async () => {
    for (let i = 0; i < 65; i++) expect((await proxy(request('GET'))).status).toBe(200)
    for (let i = 0; i < 60; i++) expect((await proxy(request())).status).toBe(200)
    expect((await proxy(request())).status).toBe(429)
    const page = await proxy(request('GET', '/projects/example/backend', false))
    expect(page.status).toBe(200)
    expect(page.headers.get('x-pathname')).toBe('/projects/example/backend')
  })

  it('keeps owner quotas separate even when requests share an IP', async () => {
    for (let i = 0; i < 60; i++) await proxy(request())
    mocks.user.mockResolvedValue({ data: { user: { id: 'owner-2' } } })
    expect((await proxy(request())).status).toBe(200)
    mocks.user.mockResolvedValue({ data: { user: { id: 'owner-1' } } })
    expect((await proxy(request())).status).toBe(429)
  })

  it('releases the action quota after the configured one-minute window', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    for (let i = 0; i < 60; i++) await proxy(request())
    expect((await proxy(request())).status).toBe(429)
    clock.mockReturnValue(1_060_001)
    expect((await proxy(request())).status).toBe(200)
  })

  it('preserves protected-page login redirects and throttles unauthenticated action attempts', async () => {
    mocks.user.mockResolvedValue({ data: { user: null } })
    const response = await proxy(request('GET', '/projects/example/backend', false))
    expect(response.status).toBe(307)
    const location = new URL(response.headers.get('location')!)
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('redirectTo')).toBe('/projects/example/backend')
    for (let i = 0; i < 60; i++) expect((await proxy(request())).status).toBe(307)
    expect((await proxy(request())).status).toBe(429)
  })

  it('preserves authenticated login redirects and keeps API quota independent', async () => {
    expect((await proxy(request('GET', '/login', false))).headers.get('location')).toBe('https://supremo.example/dashboard')
    for (let i = 0; i < 60; i++) await proxy(request())
    for (let i = 0; i < 100; i++) expect((await proxy(request('GET', '/api/example', false))).status).toBe(200)
    expect((await proxy(request('GET', '/api/example', false))).status).toBe(429)
  })
})
