import { harnessFiles } from '../templates/harness'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture(condition: string) {
  const dir = mkdtempSync(join(tmpdir(), 'supremo-policy-audit-'))
  dirs.push(dir)
  writeFileSync(join(dir, '.gitignore'), '.env*\n')
  mkdirSync(join(dir, 'scripts'))
  mkdirSync(join(dir, 'supabase/migrations'), { recursive: true })
  copyFileSync(resolve('scripts/security-audit.js'), join(dir, 'scripts/security-audit.js'))
  writeFileSync(join(dir, 'supabase/migrations/001.sql'), `
    CREATE TABLE memberships (id uuid, org_id uuid, user_id uuid);
    ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "memberships_insert_own" ON public.memberships FOR INSERT WITH CHECK (${condition});
  `)
  const audit = (category = 'RLS_MEMBERSHIP') => {
    const result = spawnSync(process.execPath, [join(dir, 'scripts/security-audit.js'), '--strict', '--json'], { encoding: 'utf8' })
    expect(result.error).toBeUndefined()
    const report = JSON.parse(result.stdout) as { findings: Array<{ category: string }> }
    return { status: result.status, findings: report.findings.filter((f) => f.category === category) }
  }
  return { dir, audit }
}
describe('auditoria executável de adesão indevida', () => {
  it.each(['user_id = auth.uid()', '(SELECT auth.uid()) = user_id', 'auth.uid() IS NOT NULL'])('detecta %s', (condition) => {
    const { audit } = fixture(condition)
    const result = audit()
    // SELECT escalar tem tratamento explícito na normalização da regra.
    expect(result.status).toBe(1)
    expect(result.findings).toHaveLength(1)
  })
  it('aceita correção por DROP posterior sem esquecer a vulnerabilidade antes dela', () => {
    const { dir, audit } = fixture('user_id = auth.uid()')
    expect(audit().findings).toHaveLength(1)
    writeFileSync(join(dir, 'supabase/migrations/002.sql'), 'DROP POLICY IF EXISTS "memberships_insert_own" ON public.memberships;')
    expect(audit()).toEqual({ status: 0, findings: [] })
  })
  it('não acusa a associação cuja condição também valida convite', () => {
    const { audit } = fixture('user_id = auth.uid() AND invitation_authorized(org_id, auth.uid())')
    expect(audit().findings).toHaveLength(0)
  })
})


describe('fronteira cliente/servidor', () => {
  it('bloqueia credencial privilegiada por importação transitiva e aceita Server Action explícita', () => {
    const { dir, audit } = fixture('user_id = auth.uid()')
    mkdirSync(join(dir, 'src/lib'), { recursive: true })
    writeFileSync(join(dir, 'src/view.tsx'), '\'use client\'\nimport { save } from "./lib/actions";\nexport const View = save;')
    writeFileSync(join(dir, 'src/lib/actions.ts'), 'export { save } from "./admin";')
    writeFileSync(join(dir, 'src/lib/admin.ts'), 'export function save() { return process.env.SUPABASE_SERVICE_ROLE_KEY; }')
    expect(audit('CLIENT_SERVER_BOUNDARY').findings).toHaveLength(1)
    writeFileSync(join(dir, 'src/lib/actions.ts'), '\'use server\'\nimport { save as persist } from "./admin";\nexport async function save() { await persist(); }')
    expect(audit('CLIENT_SERVER_BOUNDARY').findings).toHaveLength(0)
  })
})


describe('verify rápido bloqueia achados graves', () => {
  it('executa a auditoria real e recusa policy insegura mesmo no modo quick', () => {
    const { dir } = fixture('user_id = auth.uid()')
    mkdirSync(join(dir, 'bin'))
    for (const command of ['tsc', 'eslint', 'vitest']) {
      writeFileSync(join(dir, 'bin', command), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    }
    writeFileSync(join(dir, 'scripts/verify.mjs'), harnessFiles()['scripts/verify.mjs']!)
    const result = spawnSync(process.execPath, ['scripts/verify.mjs', 'quick'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    })
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).toContain('RLS_MEMBERSHIP')
    expect(result.stdout + result.stderr).toContain('falhou em: secret scan')
  })
})
