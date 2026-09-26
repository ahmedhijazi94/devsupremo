import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertFrameworkNodeVersion, linkIsolatedDependencies, linkLegacyDependencies, publicSupabaseEnvironment, readProjectStack, routePreparation, syntheticValidationEnvironment } from './framework-runtime'
import { WorkerAbortedError, WorkerTimeoutError } from './worker-process'

let cwd: string
const dependencies = { '@tanstack/react-start': '1.168.4', '@tanstack/react-router': '1.168.4', vite: '7.3.1' }
function start(): void {
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies }))
  fs.writeFileSync(path.join(cwd, 'vite.config.mts'), "import { tanstackStart } from '@tanstack/react-start/plugin/vite'\n")
}
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-framework-')) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(cwd, { recursive: true, force: true }) })

describe('framework evidence stays separate from the new-project default', () => {
  it('recognizes legacy Next without metadata and never presumes Start for unknown imports', () => {
    expect(readProjectStack(cwd)).toBeNull()
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { react: '19.2.8', vite: '7.3.1' } }))
    expect(readProjectStack(cwd)).toBeNull()
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { next: '16.3.3' } }))
    expect(readProjectStack(cwd)).toBe('nextjs')
  })
  it('recognizes Start from packages and its actual config, with optional matching metadata', () => {
    start()
    expect(readProjectStack(cwd)).toBe('tanstack-start-vite')
    fs.mkdirSync(path.join(cwd, '.supremo'))
    fs.writeFileSync(path.join(cwd, '.supremo/project.json'), JSON.stringify({ stack: 'tanstack-start-vite', scaffoldVersion: '5.0.0' }))
    expect(readProjectStack(cwd)).toBe('tanstack-start-vite')
  })
  it('rejects a claimed stack which disagrees with package evidence', () => {
    start(); fs.mkdirSync(path.join(cwd, '.supremo'))
    fs.writeFileSync(path.join(cwd, '.supremo/project.json'), JSON.stringify({ scaffoldVersion: '4.0.9' }))
    expect(() => readProjectStack(cwd)).toThrow(/dependências/)
  })
  it('rejects absent, competing or incompatible framework configs', () => {
    start(); fs.unlinkSync(path.join(cwd, 'vite.config.mts'))
    expect(() => readProjectStack(cwd)).toThrow(/Configuração/)
    start(); fs.writeFileSync(path.join(cwd, 'vite.config.ts'), 'export default {}')
    expect(() => readProjectStack(cwd)).toThrow(/ambígua/)
    fs.unlinkSync(path.join(cwd, 'vite.config.ts'))
    fs.writeFileSync(path.join(cwd, 'next.config.ts'), 'export default {}')
    expect(() => readProjectStack(cwd)).toThrow(/conflitantes/)
  })
  it('rejects a symlink rather than using external package evidence', () => {
    fs.writeFileSync(path.join(cwd, 'external.json'), JSON.stringify({ dependencies }))
    fs.symlinkSync(path.join(cwd, 'external.json'), path.join(cwd, 'package.json'))
    expect(() => readProjectStack(cwd)).toThrow()
  })
})

describe('controlled environment and preparations', () => {
  it('enforces the installed Start Node contract without changing legacy bootstrap behavior', () => {
    for (const version of ['18.20.0', '20.19.0', '22.12.9', '23.11.0', 'invalid']) expect(() => assertFrameworkNodeVersion('tanstack-start-vite', version)).toThrow(/22.13/)
    for (const version of ['22.13.0', 'v22.14.0', '24.1.0']) expect(() => assertFrameworkNodeVersion('tanstack-start-vite', version)).not.toThrow()
    expect(() => assertFrameworkNodeVersion('nextjs', '18.20.0')).not.toThrow()
    expect(() => assertFrameworkNodeVersion(null, '18.20.0')).not.toThrow()
  })
  const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://development.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-key',
    NEXT_PUBLIC_UNRELATED: 'never-convert', SUPABASE_SERVICE_ROLE_KEY: 'sentinel-private', VITE_UNTRUSTED: 'never-copy' }
  it('maps only the two named public integration values', () => {
    expect(publicSupabaseEnvironment('tanstack-start-vite', env)).toEqual({ VITE_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL, VITE_SUPABASE_ANON_KEY: 'public-key' })
    expect(publicSupabaseEnvironment('nextjs', env)).toEqual({ NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-key' })
    expect(publicSupabaseEnvironment(null, {})).toEqual({})
  })
  it('accepts the known Start public names but rejects conflicting values and newline injection', () => {
    expect(publicSupabaseEnvironment('tanstack-start-vite', { VITE_SUPABASE_URL: 'https://development.supabase.co' })).toEqual({ VITE_SUPABASE_URL: 'https://development.supabase.co' })
    expect(() => publicSupabaseEnvironment('tanstack-start-vite', { ...env, VITE_SUPABASE_URL: 'https://production.supabase.co' })).toThrow(/divergem/)
    expect(() => publicSupabaseEnvironment('nextjs', { NEXT_PUBLIC_SUPABASE_URL: 'https://dev\nVITE_SECRET=bad' })).toThrow(/inválida/)
  })
  it('uses synthetic loopback credentials for the correct framework only', () => {
    expect(syntheticValidationEnvironment('tanstack-start-vite')).toEqual({ VITE_SUPABASE_URL: 'http://127.0.0.1:9', VITE_SUPABASE_ANON_KEY: 'supremo-synthetic-smoke-key' })
    expect(syntheticValidationEnvironment(null)).toEqual({ NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'supremo-synthetic-smoke-key' })
  })
  it('uses fixed route commands and refuses a symlinked project generator', () => {
    expect(routePreparation(null, cwd, cwd)).toBeNull()
    expect(routePreparation('nextjs', cwd, cwd)).toEqual({ command: path.join(cwd, 'node_modules/next/dist/bin/next'), args: ['typegen'] })
    fs.mkdirSync(path.join(cwd, 'scripts')); fs.writeFileSync(path.join(cwd, 'scripts/generate-routes.mjs'), '// trusted fixture')
    expect(routePreparation('tanstack-start-vite', cwd, cwd)).toEqual({ command: path.join(cwd, 'scripts/generate-routes.mjs'), args: [] })
    fs.renameSync(path.join(cwd, 'scripts/generate-routes.mjs'), path.join(cwd, 'external.mjs'))
    fs.symlinkSync(path.join(cwd, 'external.mjs'), path.join(cwd, 'scripts/generate-routes.mjs'))
    expect(() => routePreparation('tanstack-start-vite', cwd, cwd)).toThrow()
  })
  it('preserves legacy package reuse and private top-level caches without copying dependency trees', async () => {
    const scratch = path.join(cwd, 'scratch'); fs.mkdirSync(scratch)
    fs.mkdirSync(path.join(cwd, 'node_modules/next'), { recursive: true })
    fs.mkdirSync(path.join(cwd, 'node_modules/.cache'))
    fs.writeFileSync(path.join(cwd, 'node_modules/.cache/live'), 'unchanged')
    fs.writeFileSync(path.join(cwd, 'node_modules/next/index.js'), 'legacy fixture')
    await linkLegacyDependencies(cwd, scratch)
    expect(fs.lstatSync(path.join(scratch, 'node_modules/next')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(scratch, 'node_modules/next/index.js'), 'utf8')).toBe('legacy fixture')
    expect(fs.existsSync(path.join(scratch, 'node_modules/.cache'))).toBe(false)
    fs.mkdirSync(path.join(scratch, 'node_modules/.cache'))
    fs.writeFileSync(path.join(scratch, 'node_modules/.cache/private'), 'private')
    expect(fs.readdirSync(path.join(cwd, 'node_modules/.cache'))).toEqual(['live'])
  })
  it('copies dependency packages and relative binaries without exposing the live workspace', async () => {
    const scratch = path.join(cwd, 'scratch'); fs.mkdirSync(scratch)
    fs.mkdirSync(path.join(cwd, 'node_modules/react'), { recursive: true })
    fs.mkdirSync(path.join(cwd, 'node_modules/.vite'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'node_modules/.vite/live'), 'unchanged')
    fs.mkdirSync(path.join(cwd, 'node_modules/.bin'))
    fs.writeFileSync(path.join(cwd, 'node_modules/react/tool.js'), 'fixture')
    fs.symlinkSync('../react/tool.js', path.join(cwd, 'node_modules/.bin/react-tool'))
    fs.writeFileSync(path.join(cwd, 'external-tool'), 'private')
    fs.symlinkSync(path.join(cwd, 'external-tool'), path.join(cwd, 'node_modules/.bin/external-tool'))
    await linkIsolatedDependencies(cwd, scratch)
    expect(fs.realpathSync(path.join(scratch, 'node_modules/.bin/react-tool'))).toBe(fs.realpathSync(path.join(scratch, 'node_modules/react/tool.js')))
    expect(fs.existsSync(path.join(scratch, 'node_modules/.bin/external-tool'))).toBe(false)
    expect(fs.lstatSync(path.join(scratch, 'node_modules/react')).isSymbolicLink()).toBe(false)
    fs.writeFileSync(path.join(scratch, 'node_modules/react/private-write'), 'isolated')
    expect(fs.existsSync(path.join(cwd, 'node_modules/react/private-write'))).toBe(false)
    expect(fs.existsSync(path.join(scratch, 'node_modules/.vite'))).toBe(false)
    fs.mkdirSync(path.join(scratch, 'node_modules/.vite'))
    fs.writeFileSync(path.join(scratch, 'node_modules/.vite/isolated'), 'new')
    expect(fs.existsSync(path.join(cwd, 'node_modules/.vite/isolated'))).toBe(false)
  })
  it('keeps binaries private when the workspace is reached through a parent directory alias', async () => {
    const realParent = path.join(cwd, 'real'), alias = path.join(cwd, 'alias')
    const workspace = path.join(realParent, 'project'), scratch = path.join(cwd, 'scratch')
    fs.mkdirSync(path.join(workspace, 'node_modules/tool'), { recursive: true })
    fs.mkdirSync(path.join(workspace, 'node_modules/.bin')); fs.mkdirSync(scratch)
    fs.writeFileSync(path.join(workspace, 'node_modules/tool/cli.js'), 'fixture')
    fs.symlinkSync('../tool/cli.js', path.join(workspace, 'node_modules/.bin/tool'))
    fs.symlinkSync(realParent, alias, 'dir')
    await linkIsolatedDependencies(path.join(alias, 'project'), scratch)
    const privateCli = path.join(scratch, 'node_modules/tool/cli.js')
    expect(fs.realpathSync(path.join(scratch, 'node_modules/.bin/tool'))).toBe(fs.realpathSync(privateCli))
    fs.writeFileSync(privateCli, 'private')
    expect(fs.readFileSync(path.join(workspace, 'node_modules/tool/cli.js'), 'utf8')).toBe('fixture')
  })
  it('copies regular executable shims without making self-referential links', async () => {
    const scratch = path.join(cwd, 'scratch'); fs.mkdirSync(scratch)
    fs.mkdirSync(path.join(cwd, 'node_modules/tool'), { recursive: true })
    fs.mkdirSync(path.join(cwd, 'node_modules/.bin'))
    fs.writeFileSync(path.join(cwd, 'node_modules/tool/cli.js'), 'fixture')
    const shim = '#!/bin/sh\nexec node "$(dirname "$0")/../tool/cli.js" "$@"\n'
    fs.writeFileSync(path.join(cwd, 'node_modules/.bin/tool'), shim, { mode: 0o755 })
    await linkIsolatedDependencies(cwd, scratch)
    const privateBin = path.join(scratch, 'node_modules/.bin/tool')
    expect(fs.lstatSync(privateBin).isFile()).toBe(true)
    expect(fs.readFileSync(privateBin, 'utf8')).toBe(shim)
    expect(fs.statSync(privateBin).mode & 0o111).toBe(0o111)
  })
  it.each(['abort', 'deadline'] as const)('stops before filesystem preparation on an expired %s budget', async (reason) => {
    const scratch = path.join(cwd, 'scratch'); fs.mkdirSync(scratch)
    const controller = new AbortController()
    if (reason === 'abort') controller.abort()
    await expect(linkIsolatedDependencies(cwd, scratch, {
      signal: controller.signal, ...(reason === 'deadline' ? { deadline: Date.now() - 1 } : {}),
    })).rejects.toBeInstanceOf(reason === 'abort' ? WorkerAbortedError : WorkerTimeoutError)
    expect(fs.existsSync(path.join(scratch, 'node_modules'))).toBe(false)
  })
  it.each(['abort', 'deadline'] as const)('interrupts traversal inside a package after %s without changing live files', async (reason) => {
    const scratch = path.join(cwd, 'scratch'); fs.mkdirSync(scratch)
    fs.mkdirSync(path.join(cwd, 'node_modules/tool/nested'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'node_modules/tool/nested/cli.js'), 'live')
    const controller = new AbortController(), now = Date.now(), copy = fs.promises.cp.bind(fs.promises)
    let time = now, copiedEntries = 0
    vi.spyOn(Date, 'now').mockImplementation(() => time)
    vi.spyOn(fs.promises, 'cp').mockImplementation(async (source, target, options) => {
      await copy(source, target, { ...options, filter: async (entry, destination) => {
        copiedEntries += 1
        if (copiedEntries === 2) {
          if (reason === 'abort') controller.abort()
          else time = now + 1001
        }
        return options?.filter ? await options.filter(entry, destination) : true
      } })
    })
    await expect(linkIsolatedDependencies(cwd, scratch, { signal: controller.signal, deadline: now + 1000 }))
      .rejects.toBeInstanceOf(reason === 'abort' ? WorkerAbortedError : WorkerTimeoutError)
    expect(copiedEntries).toBe(2)
    expect(fs.existsSync(path.join(scratch, 'node_modules/tool/nested/cli.js'))).toBe(false)
    expect(fs.readFileSync(path.join(cwd, 'node_modules/tool/nested/cli.js'), 'utf8')).toBe('live')
  })
  it('yields the event loop so cancellation can arrive during preparation', async () => {
    const scratch = path.join(cwd, 'scratch'); fs.mkdirSync(scratch)
    fs.mkdirSync(path.join(cwd, 'node_modules/tool'), { recursive: true })
    for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(cwd, `node_modules/tool/${i}.js`), 'live')
    const controller = new AbortController()
    const execution = linkIsolatedDependencies(cwd, scratch, { signal: controller.signal })
    const timer = setTimeout(() => controller.abort(), 0)
    try { await expect(execution).rejects.toBeInstanceOf(WorkerAbortedError) }
    finally { clearTimeout(timer) }
  })
})
