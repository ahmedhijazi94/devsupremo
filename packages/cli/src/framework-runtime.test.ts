import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertFrameworkNodeVersion, linkIsolatedDependencies, publicSupabaseEnvironment, readProjectStack, routePreparation, syntheticValidationEnvironment } from './framework-runtime'

let cwd: string
const dependencies = { '@tanstack/react-start': '1.168.4', '@tanstack/react-router': '1.168.4', vite: '7.3.1' }
function start(): void {
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies }))
  fs.writeFileSync(path.join(cwd, 'vite.config.mts'), "import { tanstackStart } from '@tanstack/react-start/plugin/vite'\n")
}
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-framework-')) })
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }) })

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
  it('reuses dependency packages while keeping cache directories out of the live workspace', () => {
    const scratch = path.join(cwd, 'scratch'); fs.mkdirSync(scratch)
    fs.mkdirSync(path.join(cwd, 'node_modules/react'), { recursive: true })
    fs.mkdirSync(path.join(cwd, 'node_modules/.vite'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'node_modules/.vite/live'), 'unchanged')
    linkIsolatedDependencies(cwd, scratch)
    expect(fs.lstatSync(path.join(scratch, 'node_modules/react')).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(scratch, 'node_modules/.vite'))).toBe(false)
    fs.mkdirSync(path.join(scratch, 'node_modules/.vite'))
    fs.writeFileSync(path.join(scratch, 'node_modules/.vite/isolated'), 'new')
    expect(fs.existsSync(path.join(cwd, 'node_modules/.vite/isolated'))).toBe(false)
  })
})
