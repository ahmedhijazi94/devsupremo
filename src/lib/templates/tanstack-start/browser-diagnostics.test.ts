import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, webcrypto } from 'node:crypto'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { request } from 'node:http'
import ts from 'typescript'
import { createServer, type Plugin, type ViteDevServer } from 'vite'

const projectId = '11111111-1111-4111-8111-111111111111'
const asset = path.join(__dirname, 'assets/scripts/browser-diagnostics.ts.txt')
const source = fs.readFileSync(asset, 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
const exports: { browserDiagnosticsPlugin?: () => Plugin } = {}
const fixtureBootId = '10000000-0000-4000-8000-000000000001'
let currentBootId = fixtureBootId
const requireDependency = createRequire(import.meta.url)
const fixtureCrypto = { ...(requireDependency('node:crypto') as typeof import('node:crypto')), randomUUID: () => currentBootId }
vm.runInNewContext(compiled, { exports, require: (name: string): unknown => name === 'node:crypto' ? fixtureCrypto : requireDependency(name), Buffer, process, Date, setTimeout, clearTimeout, setInterval, clearInterval })
const plugin = () => exports.browserDiagnosticsPlugin!()
const endpoint = '/__supremo/browser-diagnostics'
let root: string, server: ViteDevServer, origin: string
function artifact() { return JSON.parse(fs.readFileSync(path.join(root, '.supremo/runtime/browser-diagnostics.json'), 'utf8')) as { bootId: string; events: Record<string, unknown>[] } }
async function send(body: unknown, headers: Record<string, string> = { Origin: origin }) {
  return fetch(origin + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
}
function event(overrides: Record<string, unknown> = {}) { return { bootId: currentBootId, kind: 'error', name: 'TypeError', ...overrides } }

beforeEach(async () => {
  currentBootId = fixtureBootId
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-browser-diagnostics-'))
  fs.mkdirSync(path.join(root, '.supremo'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, '.supremo/project.json'), JSON.stringify({ projectId }))
  fs.writeFileSync(path.join(root, 'src/router.tsx'), 'export const getRouter = () => ({})')
  server = await createServer({ configFile: false, root, mode: 'development', plugins: [plugin()],
    server: { host: '127.0.0.1', port: 0, strictPort: true }, logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' })
  await server.listen()
  const address = server.httpServer!.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture address')
  origin = `http://127.0.0.1:${address.port}`
})
afterEach(async () => { await server?.close(); fs.rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs() })

describe('local browser diagnostics boundary', () => {
  it('loads through the real Vite client router graph and persists only verified source locations', async () => {
    const router = await (await fetch(origin + '/src/router.tsx')).text()
    expect(router).toContain('/@id/__x00__virtual:supremo-browser-diagnostics')
    const clientCode = await (await fetch(origin + '/@id/__x00__virtual:supremo-browser-diagnostics')).text()
    expect(clientCode).toContain("window.addEventListener('error'")
    expect(clientCode).not.toContain('eval(')
    expect((await send(event({ sourceId: createHash('sha256').update('/src/router.tsx').digest('hex'), generatedLine: 23, generatedColumn: 7 }))).status).toBe(204)
    expect(artifact().events).toEqual([expect.objectContaining({ kind: 'error', name: 'TypeError', file: 'src/router.tsx', generatedLine: 23, generatedColumn: 7, count: 1 })])
    expect(fs.statSync(path.join(root, '.supremo/runtime/browser-diagnostics.json')).mode & 0o777).toBe(0o600)
  })

  it('never sends messages, stacks, query strings, cookies, page content or arbitrary names from the browser', async () => {
    const loaded = await server.environments.client!.pluginContainer.load('\0virtual:supremo-browser-diagnostics')
    const clientCode = typeof loaded === 'string' ? loaded : loaded!.code
    const handlers = new Map<string, (event: Record<string, unknown>) => void>()
    const calls: { url: string; options: RequestInit }[] = []
    vm.runInNewContext(clientCode.replace(/import\.meta\.hot/g, 'false'), {
      window: { addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => handlers.set(name, handler) },
      location: { origin }, URL, Error, TypeError, TextEncoder, crypto: webcrypto, AbortSignal,
      fetch: async (url: string, options: RequestInit) => { calls.push({ url, options }); return new Response(null, { status: 204 }) },
    })
    const secret = 'sb_secret_never_transmit_this_password'
    const error = new TypeError(secret)
    handlers.get('error')!({ error, filename: origin + '/src/router.tsx?token=' + secret, lineno: 3, colno: 7, message: secret })
    handlers.get('unhandledrejection')!({ reason: secret })
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(JSON.stringify(calls)).not.toContain(secret)
    expect(JSON.stringify(calls)).not.toContain('router.tsx')
    for (const call of calls) {
      expect(call.url).toBe(endpoint)
      expect(call.options).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' })
      expect(Object.keys(JSON.parse(String(call.options.body)))).not.toEqual(expect.arrayContaining(['message', 'stack', 'url']))
    }
  })

  it.each([{}, { Origin: 'null' }, { Origin: 'https://evil.example' }, { Origin: 'http://127.0.0.1:1' }, { Origin: 'http://127.0.0.1.evil.example' }])('rejects absent or foreign origins %j', async headers => {
    expect((await send(event(), headers)).status).toBe(403)
    expect(artifact().events).toEqual([])
  })
  it('requires the exact origin/Host pair and same-origin fetch metadata', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(origin + endpoint, { method: 'POST', headers: { Origin: origin, Host: 'localhost:' + new URL(origin).port, 'Content-Type': 'application/json' } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode))
      })
      req.on('error', reject); req.end(JSON.stringify(event()))
    })
    expect(status).toBe(403)
    expect((await send(event(), { Origin: origin, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
  })
  it.each([{ message: 'password=secret' }, { stack: 'private stack' }, { name: 'secret-user-value' }, { file: '/Users/private/token' }, { line: -1 }, { sourceId: 'query?token=x' }, { bootId: '22222222-2222-4222-8222-222222222222' }])('rejects free values or invalid metadata %j', async extra => {
    expect((await send(event(extra))).status).toBe(400)
    expect(artifact().events).toEqual([])
  })
  it('drops unregistered source hashes instead of recording arbitrary paths or positions', async () => {
    expect((await send(event({ sourceId: 'a'.repeat(64), generatedLine: 999, generatedColumn: 1 }))).status).toBe(204)
    expect(artifact().events[0]).not.toHaveProperty('file')
    expect(artifact().events[0]).not.toHaveProperty('generatedLine')
  })
  it('bounds payloads, rejects alternate transports and keeps responses empty', async () => {
    expect((await send(event({ message: 'x'.repeat(600) }))).status).toBe(413)
    expect((await send(event(), { Origin: origin, 'Content-Type': 'text/plain' })).status).toBe(415)
    expect((await send(event(), { Origin: origin, 'Content-Encoding': 'gzip' })).status).toBe(415)
    expect((await fetch(origin + endpoint, { headers: { Origin: origin } })).status).toBe(405)
    expect((await fetch(origin + endpoint + '?token=secret', { method: 'POST', headers: { Origin: origin } })).status).toBe(400)
    const response = await send(event())
    expect(await response.text()).toBe('')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
  it('aggregates repeated observations and globally rate limits writes', async () => {
    for (let i = 0; i < 20; i++) expect((await send(event())).status).toBe(204)
    expect((await send(event())).status).toBe(429)
    expect(artifact().events).toHaveLength(1)
    expect(artifact().events[0]!.count).toBe(20)
  })
  it('clears observations on a new preview boot and rejects old browser markers', async () => {
    const old = event()
    await send(old)
    currentBootId = '10000000-0000-4000-8000-000000000002'
    await server.restart()
    expect(artifact().events).toEqual([])
    expect((await send(old)).status).toBe(400)
    expect((await send(event())).status).toBe(204)
  })
  it('does not follow a replaced runtime directory symlink', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-no-write-'))
    const payload = event()
    try {
      fs.rmSync(path.join(root, '.supremo/runtime'), { recursive: true })
      fs.symlinkSync(outside, path.join(root, '.supremo/runtime'))
      expect((await send(payload)).status).toBe(204)
      expect(fs.readdirSync(outside)).toEqual([])
    } finally { fs.unlinkSync(path.join(root, '.supremo/runtime')); fs.rmSync(outside, { recursive: true }) }
  })
  it('keeps the collector out of the SSR graph', async () => {
    const result = await server.environments.ssr!.transformRequest('/src/router.tsx')
    expect(result!.code).not.toContain('virtual:supremo-browser-diagnostics')
  })
  it('bounds observation count and expires old browser events on the next observation', async () => {
    await fetch(origin + '/src/router.tsx')
    const sourceId = createHash('sha256').update('/src/router.tsx').digest('hex')
    const initialNow = Date.now()
    const clock = vi.spyOn(Date, 'now')
    try {
      for (let index = 0; index < 25; index++) {
        clock.mockReturnValue(initialNow + Math.floor(index / 20) * 61000)
        expect((await send(event({ sourceId, generatedLine: index + 1 }))).status).toBe(204)
      }
      expect(artifact().events).toHaveLength(20)
      clock.mockReturnValue(initialNow + 50 * 61000)
      await send(event())
      expect(artifact().events).toHaveLength(1)
    } finally { clock.mockRestore() }
  })
  it.each([['build', 'development'], ['serve', 'production'], ['serve', 'preview']])('is disabled for %s/%s', (command, mode) => {
    const apply = plugin().apply
    if (typeof apply !== 'function') throw new Error('Expected apply guard')
    expect(apply({ mode }, { command: command as 'serve' | 'build', mode })).toBe(false)
  })
  it('is disabled in production or isolated validation even with development mode', () => {
    const apply = plugin().apply
    if (typeof apply !== 'function') throw new Error('Expected apply guard')
    vi.stubEnv('NODE_ENV', 'production')
    expect(apply({}, { command: 'serve', mode: 'development' })).toBe(false)
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('SUPREMO_VALIDATION', '1')
    expect(apply({}, { command: 'serve', mode: 'development' })).toBe(false)
  })
})
