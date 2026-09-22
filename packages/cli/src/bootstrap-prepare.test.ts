import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runBootstrap, type BootstrapConfig } from './bootstrap'
import { readDeviceSecret } from './device-identity'

const fixture = vi.hoisted(() => ({ root: '', failClone: false, failRuntime: false, failSave: false,
  events: [] as string[], store: new Map<string, string>(),
  keychain: { get: vi.fn(), save: vi.fn(), remove: vi.fn() },
}))
vi.mock('./auth', () => ({ defaultAuthIO: {}, openBrowser: vi.fn(async () => true),
  ensureAuthorized: async (provider: { authorize: () => Promise<void>; isAuthorized: () => boolean }) => {
    await provider.authorize(); return provider.isAuthorized()
  } }))
vi.mock('./keychain', () => ({ resolveKeychain: () => fixture.keychain }))
vi.mock('./project-runtime', () => ({ ensureProjectRuntime: vi.fn(async (cwd: string) => {
  fixture.events.push('runtime')
  expect(fixture.store.size).toBe(1)
  expect(fs.readFileSync(path.join(cwd, '.env.local'), 'utf8')).toContain('https://development-ref.supabase.co')
  expect(fs.readFileSync(path.join(cwd, '.supremo/database.json'), 'utf8')).toContain('development')
  if (fixture.failRuntime) throw new Error('runtime unavailable')
  return { node: '/fixture/node22', npm: '/fixture/npm-cli.js', version: 'v22.22.1', source: 'project', env: { PATH: '/fixture/bin' } }
}) }))
vi.mock('node:child_process', () => ({ execFileSync: vi.fn((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
  if (command === 'git' && args.includes('clone')) {
    fixture.events.push('clone')
    expect(fixture.store.size).toBe(1)
    if (fixture.failClone) throw new Error('clone failed')
    const cwd = path.join(fixture.root, 'app')
    fs.mkdirSync(path.join(cwd, '.supremo'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.supremo/project.json'), JSON.stringify({ projectId: '11111111-1111-4111-8111-111111111111', supremoUrl: 'https://supremo.example.invalid' }))
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { next: '16.3.3' } }))
    return ''
  }
  if (command === 'git') return args[0] === 'rev-parse' ? path.join(fixture.root, 'app') : 'https://github.com/owner/app.git'
  expect(command).toBe('/fixture/node22')
  expect(args).toEqual(['/fixture/npm-cli.js', 'ci'])
  expect(options.env?.PATH).toBe('/fixture/bin')
  fixture.events.push('install')
  throw new Error('dependency failure')
}) }))

const PROJECT = '11111111-1111-4111-8111-111111111111'
const ISSUER = 'https://supremo.example.invalid'
const SECRET = 'test-device-secret'
const config: BootstrapConfig = {
  project: { id: PROJECT, name: 'app', capabilities: [], scaffoldVersion: '4.0.0', securityProfile: null },
  repo: { fullName: 'owner/app', url: 'https://github.com/owner/app.git', branch: 'main' },
  gitToken: 'never-in-argv', gitTokenScope: 'installation',
  env: { NEXT_PUBLIC_SUPABASE_URL: 'https://development-ref.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-key' },
  database: { environment: 'development', projectRef: 'development-ref', automaticMigrations: true },
  daemon: { deviceId: 'device', deviceSecret: SECRET },
}
beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-bootstrap-prepare-'))
  fixture.store.clear(); fixture.events = []; fixture.failClone = false; fixture.failRuntime = false; fixture.failSave = false
  vi.clearAllMocks()
  fixture.keychain.save.mockImplementation((account: string, value: string) => {
    fixture.events.push('save')
    if (fixture.failSave) throw new Error('keychain unavailable')
    fixture.store.set(account, value)
  })
  fixture.keychain.get.mockImplementation((account: string) => fixture.store.get(account) ?? null)
  fixture.keychain.remove.mockImplementation((account: string) => fixture.store.delete(account))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/start')
    ? { deviceCode: 'fixture-code', userCode: 'fixture-user', verificationUriComplete: `${ISSUER}/authorize`, intervalSec: 0, expiresAt: new Date(Date.now() + 1000).toISOString() }
    : { status: 'ready', config })))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); fs.rmSync(fixture.root, { recursive: true, force: true }) })
const bootstrap = () => runBootstrap({ projectId: PROJECT, url: ISSUER, dir: fixture.root })

describe('bootstrap preserves browser authorization before fallible local setup', () => {
  it('keeps the confirmed credential even if cloning fails', async () => {
    fixture.failClone = true
    await expect(bootstrap()).rejects.toThrow('clone failed')
    expect(fixture.events).toEqual(['save', 'clone'])
    expect(readDeviceSecret(fixture.keychain, PROJECT, ISSUER)).toBe(SECRET)
  })

  it('writes public env and database configuration before runtime preparation fails', async () => {
    fixture.failRuntime = true
    await expect(bootstrap()).rejects.toThrow('runtime unavailable')
    expect(fixture.events).toEqual(['save', 'clone', 'runtime'])
    expect(readDeviceSecret(fixture.keychain, PROJECT, ISSUER)).toBe(SECRET)
    expect(fs.existsSync(path.join(fixture.root, 'app/.supremo/onboarding.json'))).toBe(false)
  })

  it('uses the selected Node for dependency installation and retains credentials when npm fails', async () => {
    await expect(bootstrap()).rejects.toThrow('dependency failure')
    expect(fixture.events).toEqual(['save', 'clone', 'runtime', 'install'])
    expect(readDeviceSecret(fixture.keychain, PROJECT, ISSUER)).toBe(SECRET)
  })

  it('fails before cloning if secure credential storage cannot be confirmed', async () => {
    fixture.failSave = true
    await expect(bootstrap()).rejects.toThrow('keychain unavailable')
    expect(fixture.events).toEqual(['save'])
  })
})
