import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runPrepare } from './prepare'
import { authorizeDevice, linkSupabaseRemote, type BootstrapConfig } from './bootstrap'
import { readDeviceSecret, saveDeviceIdentity } from './device-identity'
import { ensureProjectRuntime } from './project-runtime'
import { configureAuthorizedCheckout } from './prepare-config'

const fixture = vi.hoisted(() => ({
  cwd: '', remote: 'https://github.com/owner/app.git', preview: false, failInstall: false, failRuntime: false,
  commands: [] as string[][], secrets: new Map<string, string>(),
  keychain: { save: vi.fn(), get: vi.fn(), remove: vi.fn() },
}))
vi.mock('./keychain', () => ({ resolveKeychain: () => fixture.keychain }))
vi.mock('./project-runtime', () => ({ ensureProjectRuntime: vi.fn(async () => {
  if (fixture.failRuntime) throw new Error('Node download failed')
  return { node: '/fixture/node22', npm: '/fixture/npm-cli.js', version: 'v22.22.1', source: 'project', env: { PATH: '/fixture/bin' } }
}) }))
vi.mock('./host-adapters', () => ({ inspectHostAdapters: () => ({ adapters: {
  codex: { verified: true, integrationMode: 'enforced', issues: [] },
} }) }))
vi.mock('./turn-validation', () => ({ validationWorkerHealthy: () => true }))
vi.mock('./bootstrap', async importOriginal => ({
  ...await importOriginal<typeof import('./bootstrap')>(),
  authorizeDevice: vi.fn(), linkSupabaseRemote: vi.fn(async () => true), gitHooksVerified: () => true,
}))
vi.mock('node:child_process', () => ({ execFileSync: vi.fn((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
  fixture.commands.push([command, ...args])
  if (command === 'git') return args[0] === 'rev-parse' ? fixture.cwd : fixture.remote
  expect(command).toBe('/fixture/node22')
  expect(options.env?.PATH).toBe('/fixture/bin')
  if (args[0] === 'scripts/preview.mjs') return JSON.stringify({ running: fixture.preview, healthy: fixture.preview, url: 'http://localhost:3017' })
  if (args.includes('--status')) return '{"running":true}'
  if (args[0] === '/fixture/npm-cli.js' && args[1] === 'ci') {
    if (fixture.failInstall) throw new Error('installation failed')
    fs.mkdirSync(path.join(fixture.cwd, 'node_modules'), { recursive: true })
  }
  if (args.includes('preview:ensure')) fixture.preview = true
  return ''
}) }))

const PROJECT = '11111111-1111-4111-8111-111111111111'
const ISSUER = 'https://supremo.example.invalid/control'
const SECRET = 'test-only-device-secret'
const config = (): BootstrapConfig => ({
  project: { id: PROJECT, name: 'app', capabilities: [], scaffoldVersion: '4.0.0', securityProfile: null, stack: 'nextjs' },
  repo: { url: 'https://github.com/owner/app.git', fullName: 'owner/app', branch: 'main' },
  gitToken: 'test-only-git-token', gitTokenScope: 'installation',
  env: { NEXT_PUBLIC_SUPABASE_URL: 'https://development-ref.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-key', PRIVATE_SECRET: 'must-not-write' },
  database: { environment: 'development', projectRef: 'development-ref', automaticMigrations: true },
  supabase: { projectRef: 'development-ref', dbPassword: 'must-not-write', majorVersion: 17 },
  daemon: { deviceId: 'device', deviceSecret: SECRET },
})

beforeEach(() => {
  fixture.cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-prepare-'))
  fixture.preview = false; fixture.failInstall = false; fixture.failRuntime = false
  fixture.remote = 'https://github.com/owner/app.git'; fixture.commands = []; fixture.secrets.clear()
  vi.clearAllMocks()
  fixture.keychain.save.mockImplementation((account: string, value: string) => fixture.secrets.set(account, value))
  fixture.keychain.get.mockImplementation((account: string) => fixture.secrets.get(account) ?? null)
  fixture.keychain.remove.mockImplementation((account: string) => fixture.secrets.delete(account))
  vi.mocked(authorizeDevice).mockResolvedValue(config())
  vi.mocked(linkSupabaseRemote).mockImplementation(async (cwd, supabase) => {
    fs.mkdirSync(path.join(cwd, 'supabase/.temp'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'supabase/.temp/project-ref'), supabase.projectRef)
    return true
  })
  vi.stubGlobal('fetch', vi.fn(async (_url: string, request: RequestInit) => {
    expect(request.redirect).toBe('error')
    expect(JSON.parse(String(request.body))).toEqual({ projectId: PROJECT, deviceSecret: SECRET, operation: 'status' })
    return Response.json(config().database)
  }))
  fs.mkdirSync(path.join(fixture.cwd, '.supremo'))
  fs.writeFileSync(path.join(fixture.cwd, '.supremo/project.json'), JSON.stringify({ projectId: PROJECT, supremoUrl: ISSUER }))
  fs.writeFileSync(path.join(fixture.cwd, 'package.json'), JSON.stringify({ dependencies: { next: '16.3.3' } }))
})
afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(fixture.cwd, { recursive: true, force: true }) })
const prepare = () => runPrepare({ cwd: fixture.cwd, url: ISSUER, host: 'codex' })
const save = () => saveDeviceIdentity(fixture.keychain, PROJECT, ISSUER, SECRET)
const configure = () => configureAuthorizedCheckout(fixture.cwd, 'nextjs', config())
const existingLink = (): void => {
  fs.mkdirSync(path.join(fixture.cwd, 'supabase/.temp'), { recursive: true })
  fs.writeFileSync(path.join(fixture.cwd, 'supabase/.temp/project-ref'), 'development-ref')
}

describe('existing-checkout preparation', () => {
  it('persists browser authorization and public configuration before failed installation, then resumes without another browser flow', async () => {
    fixture.failInstall = true
    const failed = await prepare()
    expect(failed).toMatchObject({ state: 'not_ready', authorization: 'authorized', dependencies: 'pending' })
    expect(failed.issues.join(' ')).toContain('dependências')
    expect(readDeviceSecret(fixture.keychain, PROJECT, ISSUER)).toBe(SECRET)
    expect(fs.readFileSync(path.join(fixture.cwd, '.env.local'), 'utf8')).toContain('development-ref.supabase.co')
    expect(fs.readFileSync(path.join(fixture.cwd, '.supremo/database.json'), 'utf8')).toContain('development')
    const consent = fs.readFileSync(path.join(fixture.cwd, '.supremo/onboarding.json'), 'utf8')
    expect(JSON.parse(consent)).toMatchObject({ version: 1, projectId: PROJECT, issuer: ISSUER, scope: 'project-development' })
    expect(linkSupabaseRemote).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(fixture.cwd, 'supabase/.temp/project-ref'))).toBe(false)
    fixture.failInstall = false
    const resumed = await prepare()
    expect(resumed).toMatchObject({ state: 'ready', authorization: 'reused', dependencies: 'installed', previewUrl: 'http://localhost:3017' })
    expect(authorizeDevice).toHaveBeenCalledTimes(1)
    expect(linkSupabaseRemote).toHaveBeenCalledExactlyOnceWith(fixture.cwd, { projectRef: 'development-ref' })
    expect(fs.readFileSync(path.join(fixture.cwd, 'supabase/.temp/project-ref'), 'utf8')).toBe('development-ref')
    expect(fs.readFileSync(path.join(fixture.cwd, '.supremo/onboarding.json'), 'utf8')).toBe(consent)
    expect(fixture.commands.flat().join(' ')).not.toMatch(/clone|reset|checkout|checkpoint|verify|test:/)
    const stored = ['.env.local', '.supremo/database.json', '.supremo/prepare-readiness.json']
      .map(file => fs.readFileSync(path.join(fixture.cwd, file), 'utf8')).join('\n')
    expect(stored).not.toContain(SECRET)
    expect(stored).not.toContain('must-not-write')
  })

  it('preserves authorization and configuration when acquiring a compatible Node fails', async () => {
    fixture.failRuntime = true
    expect(await prepare()).toMatchObject({ state: 'not_ready', runtimeVersion: null })
    expect(readDeviceSecret(fixture.keychain, PROJECT, ISSUER)).toBe(SECRET)
    expect(fs.existsSync(path.join(fixture.cwd, '.env.local'))).toBe(true)
    fixture.failRuntime = false
    expect(await prepare()).toMatchObject({ state: 'ready', authorization: 'reused', runtimeVersion: 'v22.22.1' })
    expect(authorizeDevice).toHaveBeenCalledTimes(1)
  })

  it('reuses a healthy preview, installed dependencies and issuer-bound identity while preserving user environment bytes', async () => {
    save(); configure(); existingLink(); fixture.preview = true
    fs.mkdirSync(path.join(fixture.cwd, 'node_modules'))
    const env = '# custom\nNEXT_PUBLIC_SUPABASE_URL="https://development-ref.supabase.co"\nNEXT_PUBLIC_SUPABASE_ANON_KEY=rotated-public-key\nFEATURE=1\n'
    fs.writeFileSync(path.join(fixture.cwd, '.env.local'), env)
    expect(await prepare()).toMatchObject({ state: 'ready', authorization: 'reused', dependencies: 'reused', previewUrl: 'http://localhost:3017' })
    expect(authorizeDevice).not.toHaveBeenCalled()
    expect(linkSupabaseRemote).not.toHaveBeenCalled()
    expect(fixture.commands.flat()).not.toContain('ci')
    expect(fixture.commands.flat()).not.toContain('preview:ensure')
    expect(fixture.commands.flat()).not.toContain('--ensure')
    expect(fs.readFileSync(path.join(fixture.cwd, '.env.local'), 'utf8')).toBe(env)
  })

  it('never replaces dependencies used by a healthy preview', async () => {
    save(); configure(); fixture.preview = true
    expect(await prepare()).toMatchObject({ state: 'not_ready', previewUrl: 'http://localhost:3017' })
    expect(fixture.commands.flat()).not.toContain('ci')
    expect(fixture.commands.flat()).not.toContain('preview:ensure')
  })

  it('links the remotely confirmed development target without patching application config', async () => {
    expect(await prepare()).toMatchObject({ state: 'ready', authorization: 'authorized' })
    expect(linkSupabaseRemote).toHaveBeenCalledWith(fixture.cwd, { projectRef: 'development-ref', dbPassword: 'must-not-write' })
  })

  it.each(['failed', 'missing', 'different-target', 'throws'] as const)('reports an incomplete %s link while preserving a healthy preview and saved authorization', async scenario => {
    save(); configure(); fixture.preview = true
    fs.mkdirSync(path.join(fixture.cwd, 'node_modules'))
    vi.mocked(linkSupabaseRemote).mockImplementation(async () => {
      if (scenario === 'throws') throw new Error('Supabase unavailable')
      if (scenario === 'different-target') {
        existingLink()
        fs.writeFileSync(path.join(fixture.cwd, 'supabase/.temp/project-ref'), 'wrong-ref')
      }
      return scenario !== 'failed'
    })
    const result = await prepare()
    expect(result).toMatchObject({ state: 'not_ready', databaseStatus: 'confirmed', authorization: 'reused', previewUrl: 'http://localhost:3017' })
    expect(result.issues.join(' ')).toContain('link local do Supabase')
    expect(authorizeDevice).not.toHaveBeenCalled()
    expect(fixture.commands.flat()).not.toContain('ci')
    expect(fixture.commands.flat()).not.toContain('preview:ensure')
    expect(linkSupabaseRemote).toHaveBeenCalledExactlyOnceWith(fixture.cwd, { projectRef: 'development-ref' })
    if (scenario !== 'different-target') expect(fs.existsSync(path.join(fixture.cwd, 'supabase/.temp/project-ref'))).toBe(false)
  })

  it('fills missing public values after one official authorization, preserving nonempty values and unrelated lines', async () => {
    save()
    const original = '# custom\nNEXT_PUBLIC_SUPABASE_ANON_KEY=rotated-public-key\nFEATURE=1\n'
    fs.writeFileSync(path.join(fixture.cwd, '.env.local'), original)
    expect(await prepare()).toMatchObject({ state: 'ready', authorization: 'authorized' })
    expect(authorizeDevice).toHaveBeenCalledOnce()
    expect(fs.readFileSync(path.join(fixture.cwd, '.env.local'), 'utf8')).toBe(`${original}NEXT_PUBLIC_SUPABASE_URL=https://development-ref.supabase.co\n`)
  })

  it('materializes actual Vite public variables when a Start checkout only has legacy public names', async () => {
    save(); configure()
    fs.writeFileSync(path.join(fixture.cwd, '.env.local'), 'NEXT_PUBLIC_SUPABASE_URL=https://development-ref.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=preserved-rotated-key\n')
    fs.writeFileSync(path.join(fixture.cwd, 'package.json'), JSON.stringify({ dependencies: {
      '@tanstack/react-start': '1.1.0', '@tanstack/react-router': '1.1.0', vite: '7.0.0',
    } }))
    fs.writeFileSync(path.join(fixture.cwd, 'vite.config.ts'), "import { tanstackStart } from '@tanstack/react-start/plugin/vite'\n")
    const startConfig = config(); startConfig.project.stack = 'tanstack-start-vite'
    vi.mocked(authorizeDevice).mockResolvedValue(startConfig)
    expect(await prepare()).toMatchObject({ state: 'ready' })
    const env = fs.readFileSync(path.join(fixture.cwd, '.env.local'), 'utf8')
    expect(env).toContain('VITE_SUPABASE_URL=https://development-ref.supabase.co\n')
    expect(env).toContain('VITE_SUPABASE_ANON_KEY=preserved-rotated-key\n')
  })
})

describe('preparation trust boundaries', () => {
  it('refuses an issuer mismatch before touching credentials or starting authorization', async () => {
    fs.writeFileSync(path.join(fixture.cwd, '.supremo/project.json'), JSON.stringify({ projectId: PROJECT, supremoUrl: 'https://other.example.invalid' }))
    await expect(prepare()).rejects.toThrow('origem')
    expect(fixture.keychain.get).not.toHaveBeenCalled()
    expect(authorizeDevice).not.toHaveBeenCalled()
    expect(ensureProjectRuntime).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(fixture.cwd, '.supremo/onboarding.json'))).toBe(false)
  })

  it('refuses a remote that differs from the authorized repository while retaining browser-approved identity', async () => {
    fixture.remote = 'git@github.com:other/app.git'
    await expect(prepare()).rejects.toThrow('repositório autorizado')
    expect(readDeviceSecret(fixture.keychain, PROJECT, ISSUER)).toBe(SECRET)
    expect(fs.existsSync(path.join(fixture.cwd, '.env.local'))).toBe(false)
    expect(ensureProjectRuntime).not.toHaveBeenCalled()
  })

  it('refuses returned credentials for a different project without storing them', async () => {
    const other = config(); other.project.id = '22222222-2222-4222-8222-222222222222'
    vi.mocked(authorizeDevice).mockResolvedValue(other)
    await expect(prepare()).rejects.toThrow('Projeto autorizado diverge')
    expect(fixture.secrets.size).toBe(0)
  })

  it.each(['production', 'unknown'])('refuses %s metadata without authorizing or installing', async environment => {
    save(); configure()
    fs.writeFileSync(path.join(fixture.cwd, '.supremo/database.json'), JSON.stringify({ ...config().database, environment }))
    await expect(prepare()).rejects.toThrow('protegidos')
    expect(authorizeDevice).not.toHaveBeenCalled()
    expect(ensureProjectRuntime).not.toHaveBeenCalled()
    expect(linkSupabaseRemote).not.toHaveBeenCalled()
  })

  it('does not replace a configured database target with the returned target', async () => {
    fs.writeFileSync(path.join(fixture.cwd, '.env.local'), 'NEXT_PUBLIC_SUPABASE_URL=https://other-ref.supabase.co\n')
    await expect(prepare()).rejects.toThrow('valores existentes preservados')
    expect(fs.readFileSync(path.join(fixture.cwd, '.env.local'), 'utf8')).toContain('other-ref')
    expect(linkSupabaseRemote).not.toHaveBeenCalled()
  })

  it('refuses a conflicting local Supabase link before running setup', async () => {
    save(); configure()
    fs.mkdirSync(path.join(fixture.cwd, 'supabase/.temp'), { recursive: true })
    fs.writeFileSync(path.join(fixture.cwd, 'supabase/.temp/project-ref'), 'other-ref')
    await expect(prepare()).rejects.toThrow('outro banco')
    expect(ensureProjectRuntime).not.toHaveBeenCalled()
  })

  it.each(['production', 'unknown', 'different-target'])('refuses a fresh remote %s binding without replacing the local setup', async environment => {
    save(); configure()
    const original = fs.readFileSync(path.join(fixture.cwd, '.supremo/database.json'), 'utf8')
    vi.mocked(fetch).mockResolvedValue(Response.json({ ...config().database,
      environment: environment === 'different-target' ? 'development' : environment,
      projectRef: environment === 'different-target' ? 'other-ref' : 'development-ref',
    }))
    expect(await prepare()).toMatchObject({ state: 'not_ready', databaseStatus: 'pending' })
    expect(fs.readFileSync(path.join(fixture.cwd, '.supremo/database.json'), 'utf8')).toBe(original)
    expect(authorizeDevice).not.toHaveBeenCalled()
    expect(ensureProjectRuntime).not.toHaveBeenCalled()
    expect(linkSupabaseRemote).not.toHaveBeenCalled()
  })

  it('renews a revoked credential once at the explicit issuer and retries only with the newly confirmed identity', async () => {
    save(); configure()
    const renewed = config(); renewed.daemon = { deviceId: 'renewed', deviceSecret: 'new-device-secret' }
    vi.mocked(authorizeDevice).mockResolvedValue(renewed)
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(Response.json(config().database))
    expect(await prepare()).toMatchObject({ state: 'ready', databaseStatus: 'confirmed', authorization: 'authorized' })
    expect(authorizeDevice).toHaveBeenCalledExactlyOnceWith(PROJECT, ISSUER)
    expect(readDeviceSecret(fixture.keychain, PROJECT, ISSUER)).toBe('new-device-secret')
    expect(vi.mocked(fetch).mock.calls.map(([url, options]) => ({ url, redirect: options?.redirect,
      body: JSON.parse(String(options?.body)) as unknown }))).toEqual([
      { url: `${ISSUER}/api/database`, redirect: 'error', body: { projectId: PROJECT, deviceSecret: SECRET, operation: 'status' } },
      { url: `${ISSUER}/api/database`, redirect: 'error', body: { projectId: PROJECT, deviceSecret: 'new-device-secret', operation: 'status' } },
    ])
  })

  it('stops after one browser renewal and one retry if the new credential is also refused', async () => {
    save(); configure()
    vi.mocked(fetch).mockResolvedValue(new Response('unauthorized', { status: 401 }))
    expect(await prepare()).toMatchObject({ state: 'not_ready', databaseStatus: 'pending', authorization: 'authorized' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(authorizeDevice).toHaveBeenCalledExactlyOnceWith(PROJECT, ISSUER)
    expect(ensureProjectRuntime).not.toHaveBeenCalled()
  })

  it('does not start a second browser flow when this invocation already authorized a new identity', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('unauthorized', { status: 401 }))
    expect(await prepare()).toMatchObject({ state: 'not_ready', databaseStatus: 'pending' })
    expect(authorizeDevice).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    expect(ensureProjectRuntime).not.toHaveBeenCalled()
  })

  it.each(['forbidden', 'network'])('does not renew or prepare on a %s status failure', async scenario => {
    save(); configure()
    if (scenario === 'forbidden') vi.mocked(fetch).mockResolvedValue(new Response('forbidden', { status: 403 }))
    else vi.mocked(fetch).mockRejectedValue(new Error('network unavailable'))
    expect(await prepare()).toMatchObject({ state: 'not_ready', databaseStatus: 'pending', authorization: 'reused' })
    expect(authorizeDevice).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
    expect(ensureProjectRuntime).not.toHaveBeenCalled()
  })

  it.each(['project', 'repository', 'database'] as const)('rejects a mismatched %s returned during renewal before retrying status', async scenario => {
    save(); configure()
    const renewed = config()
    if (scenario === 'project') renewed.project.id = '22222222-2222-4222-8222-222222222222'
    if (scenario === 'repository') renewed.repo = { ...renewed.repo, fullName: 'other/app', url: 'https://github.com/other/app.git' }
    if (scenario === 'database') renewed.database = { environment: 'production', projectRef: 'development-ref', automaticMigrations: false }
    vi.mocked(authorizeDevice).mockResolvedValue(renewed)
    vi.mocked(fetch).mockResolvedValue(new Response('unauthorized', { status: 401 }))
    await expect(prepare()).rejects.toThrow()
    expect(authorizeDevice).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    expect(ensureProjectRuntime).not.toHaveBeenCalled()
    expect(linkSupabaseRemote).not.toHaveBeenCalled()
  })

  it('replaces a legacy-only identity through the browser without sending or trusting its unbound secret', async () => {
    configure()
    fixture.secrets.set(PROJECT, 'old-unbound-device-secret')
    expect(await prepare()).toMatchObject({ state: 'ready', authorization: 'authorized' })
    expect(authorizeDevice).toHaveBeenCalledExactlyOnceWith(PROJECT, ISSUER)
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain('old-unbound-device-secret')
    expect(readDeviceSecret(fixture.keychain, PROJECT, ISSUER)).toBe(SECRET)
    expect(fixture.secrets.has(PROJECT)).toBe(false)
  })

  it.each(['', '{broken', JSON.stringify({ version: 1, projectId: PROJECT, issuer: 'https://other.example.invalid', secret: SECRET })])(
    'refuses bound-identity corruption or issuer mismatch instead of treating it as legacy: %s', async stored => {
      configure()
      fixture.secrets.set(`identity-v1:${PROJECT}`, stored)
      fixture.secrets.set(PROJECT, 'old-unbound-device-secret')
      await expect(prepare()).rejects.toThrow()
      expect(authorizeDevice).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
      expect(ensureProjectRuntime).not.toHaveBeenCalled()
      expect(fixture.secrets.get(`identity-v1:${PROJECT}`)).toBe(stored)
    },
  )

  it.each(['.env.local', '.supremo/prepare-readiness.json', '.supremo/onboarding.json'])('refuses a symlinked setup artifact at %s', async relative => {
    save(); configure()
    const outside = path.join(fixture.cwd, 'unchanged-app.txt')
    fs.writeFileSync(outside, 'application code')
    fs.rmSync(path.join(fixture.cwd, relative), { force: true })
    fs.symlinkSync(outside, path.join(fixture.cwd, relative))
    await expect(prepare()).rejects.toThrow()
    expect(fs.readFileSync(outside, 'utf8')).toBe('application code')
  })

  it('replaces a readiness hardlink without modifying the application file sharing its inode', async () => {
    save(); configure(); existingLink()
    const application = path.join(fixture.cwd, 'unchanged-app.txt')
    fs.writeFileSync(application, 'application code')
    fs.linkSync(application, path.join(fixture.cwd, '.supremo/prepare-readiness.json'))
    expect(await prepare()).toMatchObject({ state: 'ready' })
    expect(fs.readFileSync(application, 'utf8')).toBe('application code')
    expect(JSON.parse(fs.readFileSync(path.join(fixture.cwd, '.supremo/prepare-readiness.json'), 'utf8'))).toMatchObject({ state: 'ready' })
  })
})
