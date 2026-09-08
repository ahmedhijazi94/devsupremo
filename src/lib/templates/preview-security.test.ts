import { describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { CookieOptions } from '@supabase/ssr'
import ts from 'typescript'
import { buildProjectFiles } from './project-files'

type TestEnv = Record<string, string | undefined>
type Cookie = { name: string; value: string; options: CookieOptions }
type CookieMethods = {
  getAll: () => { name: string; value: string }[]
  setAll: (values: Cookie[], headers: Record<string, string>) => void
}
type ClientOptions = { cookieOptions?: CookieOptions; cookies?: CookieMethods }
type Config = {
  env: Record<string, string>
  headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]>
}
type Proxy = (request: NextRequest) => Promise<NextResponse> | NextResponse

/** Generated modules execute against real Next request/response serialization. */
function generated<T>(filePath: string, env: TestEnv, dependencies: Record<string, unknown> = {}, kind: 'solo' | 'public' = 'solo', inIframe = false): T {
  const source = buildProjectFiles({ projectName: 'security-fixture', description: '', kind }).find((file) => file.path === filePath)?.content
  if (!source) throw new Error(`Generated module missing: ${filePath}`)
  const compiled = ts.transpileModule(source, {
    fileName: filePath,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports: Record<string, unknown> = {}
  const windowSelf = {}
  new Function('exports', 'require', 'process', 'window', compiled)(exports, (name: string): unknown => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`)
    return dependencies[name]
  }, { env }, { self: windowSelf, top: inIframe ? {} : windowSelf })
  return exports as T
}

function environment(mode: TestEnv) {
  const { default: config } = generated<{ default: Config }>('next.config.ts', mode)
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-key',
    ...mode, ...config.env,
  }
  return { config, env }
}

const modes: { name: string; env: TestEnv; cookieOptions: CookieOptions; hosted: boolean }[] = [
  { name: 'local development', env: { NODE_ENV: 'development' }, cookieOptions: { sameSite: 'lax', secure: false, partitioned: false }, hosted: false },
  { name: 'local development preserving remote preview flags', env: { NODE_ENV: 'development', VERCEL_ENV: 'preview', SUPREMO_PREVIEW: '1' }, cookieOptions: { sameSite: 'lax', secure: false, partitioned: false }, hosted: false },
  { name: 'production', env: { NODE_ENV: 'production', VERCEL_ENV: 'production' }, cookieOptions: { sameSite: 'lax', secure: true, partitioned: false }, hosted: false },
  { name: 'Vercel preview', env: { NODE_ENV: 'production', VERCEL_ENV: 'preview' }, cookieOptions: { sameSite: 'none', secure: true, partitioned: true }, hosted: true },
  { name: 'Supremo hosted preview', env: { NODE_ENV: 'production', VERCEL_ENV: 'production', SUPREMO_PREVIEW: '1' }, cookieOptions: { sameSite: 'none', secure: true, partitioned: true }, hosted: true },
]

const renewedCookies: Cookie[] = [
  { name: 'sb-auth.0', value: 'renewed-part-0', options: { path: '/', maxAge: 3600, sameSite: 'lax' } },
  { name: 'sb-auth.1', value: 'renewed-part-1', options: { path: '/', maxAge: 3600, sameSite: 'lax' } },
]
const noCache = { 'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0', Expires: '0', Pragma: 'no-cache' }

function proxyFixture(env: TestEnv, batches: Cookie[][] = [renewedCookies]) {
  const createServerClient = vi.fn((_url: string, _key: string, options: ClientOptions) => ({
    auth: {
      getUser: async () => {
        if (!options.cookies) throw new Error('Proxy cookie adapter missing')
        for (const batch of batches) options.cookies.setAll(batch, noCache)
        return { data: { user: { id: 'synthetic-user' } }, error: null }
      },
    },
  }))
  const { proxy } = generated<{ proxy: Proxy }>('proxy.ts', env, {
    'next/server': { NextResponse }, '@supabase/ssr': { createServerClient },
  })
  return { proxy, createServerClient }
}

describe('generated cookie policy is coherent across all session writers', () => {
  it.each(modes)('$name', async (mode) => {
    const { config, env } = environment(mode.env)
    expect(config.env).toEqual({ NEXT_PUBLIC_SUPREMO_HOSTED_PREVIEW: mode.hosted ? '1' : '0' })

    const createBrowserClient = vi.fn((_url: string, _key: string, options: ClientOptions) => options)
    for (const inIframe of [false, true]) {
      const browser = generated<{ createClient: () => ClientOptions }>('lib/supabase/client.ts', env, {
        '@supabase/ssr': { createBrowserClient },
      }, 'solo', inIframe)
      expect(browser.createClient().cookieOptions).toEqual(mode.cookieOptions)
    }

    const written: Cookie[] = []
    const cookieStore = {
      getAll: () => [{ name: 'sb-auth.0', value: 'previous-token' }],
      set: (name: string, value: string, options: CookieOptions) => { written.push({ name, value, options }) },
    }
    const createServerClient = vi.fn((_url: string, _key: string, options: ClientOptions) => options)
    const server = generated<{ createClient: () => Promise<ClientOptions> }>('lib/supabase/server.ts', env, {
      '@supabase/ssr': { createServerClient }, 'next/headers': { cookies: async () => cookieStore },
    })
    const serverOptions = await server.createClient()
    expect(serverOptions.cookieOptions).toEqual(mode.cookieOptions)
    expect(serverOptions.cookies?.getAll()).toEqual(cookieStore.getAll())
    serverOptions.cookies?.setAll(renewedCookies, noCache)
    expect(written).toEqual(renewedCookies.map((cookie) => ({ ...cookie, options: { ...cookie.options, ...mode.cookieOptions } })))

    const fixture = proxyFixture(env)
    const response = await fixture.proxy(new NextRequest(mode.env.NODE_ENV === 'development' ? 'http://localhost:3000/app' : 'https://app.example.invalid/app'))
    expect(fixture.createServerClient.mock.calls[0]?.[2].cookieOptions).toEqual(mode.cookieOptions)
    for (const cookie of renewedCookies) {
      expect(response.cookies.get(cookie.name)).toMatchObject({ name: cookie.name, value: cookie.value, ...mode.cookieOptions })
    }
  })
})

describe('generated proxy propagates renewal without losing headers or cookie chunks', () => {
  it('updates the current server render and browser while preserving the nonce and cache protection', async () => {
    const { env } = environment({ NODE_ENV: 'development' })
    const fixture = proxyFixture(env, [[renewedCookies[0]!], [renewedCookies[1]!]])
    const request = new NextRequest('http://localhost:3000/app', {
      headers: { cookie: 'sb-auth.0=expired; sb-auth.1=expired; preferences=preserved', 'x-custom-input': 'retained' },
    })
    const response = await fixture.proxy(request)

    for (const cookie of renewedCookies) {
      expect(request.cookies.get(cookie.name)?.value).toBe(cookie.value)
      expect(response.cookies.get(cookie.name)?.value).toBe(cookie.value)
      expect(response.headers.get('x-middleware-request-cookie')).toContain(`${cookie.name}=${cookie.value}`)
    }
    expect(response.headers.get('x-middleware-request-cookie')).toContain('preferences=preserved')
    expect(response.headers.get('x-middleware-request-cookie')).not.toContain('expired')
    expect(response.headers.get('x-middleware-request-x-custom-input')).toBe('retained')
    const csp = response.headers.get('content-security-policy')
    const nonce = response.headers.get('x-middleware-request-x-nonce')
    expect(nonce).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(csp).toContain(`'nonce-${nonce}'`)
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(csp)
    expect(response.headers.get('cache-control')).toBe(noCache['Cache-Control'])
    expect(response.headers.get('expires')).toBe('0')
    expect(response.headers.get('pragma')).toBe('no-cache')
  })

  it('keeps auth configuration optional without suppressing security headers', async () => {
    const fixture = proxyFixture({ NODE_ENV: 'development', NEXT_PUBLIC_SUPREMO_HOSTED_PREVIEW: '0' })
    const response = await fixture.proxy(new NextRequest('http://localhost:3000/login'))
    expect(fixture.createServerClient).not.toHaveBeenCalled()
    expect(response.cookies.getAll()).toEqual([])
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
  })
})

describe('generated transport headers preserve local HTTP and production protection', () => {
  it.each(modes)('$name', async (mode) => {
    const { config, env } = environment(mode.env)
    const rules = await config.headers()
    const headers = new Map(rules.flatMap((rule) => rule.headers.map((header) => [header.key, header.value] as const)))
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(headers.get('Content-Security-Policy')).toBeUndefined()
    const fixture = proxyFixture(env, [])
    const response = await fixture.proxy(new NextRequest(mode.env.NODE_ENV === 'development' ? 'http://localhost:3000/login' : 'https://app.example.invalid/login'))
    const csp = response.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("'strict-dynamic'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("object-src 'none'")

    if (mode.env.NODE_ENV === 'development') {
      expect(headers.has('Strict-Transport-Security')).toBe(false)
      expect(csp).not.toContain('upgrade-insecure-requests')
      expect(csp).toContain("frame-ancestors 'self' http://localhost:*")
      expect(csp).toContain("'unsafe-eval'")
      expect(headers.has('X-Frame-Options')).toBe(false)
    } else {
      expect(headers.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains; preload')
      expect(csp).toContain('upgrade-insecure-requests')
      expect(csp).not.toContain("'unsafe-eval'")
      if (mode.hosted) {
        expect(csp.match(/frame-ancestors [^;]+/)?.[0]).toMatch(/^frame-ancestors 'self' https:\/\/[^ ;*]+$/)
        expect(headers.has('X-Frame-Options')).toBe(false)
      } else {
        expect(csp).toContain("frame-ancestors 'none'")
        expect(headers.get('X-Frame-Options')).toBe('DENY')
      }
    }
  })

  it('also preserves CSP for public projects without loading any auth client', async () => {
    const { env } = environment({ NODE_ENV: 'production' })
    const { proxy } = generated<{ proxy: Proxy }>('proxy.ts', env, { 'next/server': { NextResponse } }, 'public')
    const first = await proxy(new NextRequest('https://app.example.invalid/'))
    const second = await proxy(new NextRequest('https://app.example.invalid/'))
    expect(first.headers.get('content-security-policy')).toContain('upgrade-insecure-requests')
    expect(first.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(first.headers.get('x-middleware-request-x-nonce')).not.toBe(second.headers.get('x-middleware-request-x-nonce'))
  })
})
