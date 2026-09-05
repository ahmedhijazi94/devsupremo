import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { validateLocalTarget } from './database'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-db-test-')); dirs.push(dir)
  fs.mkdirSync(path.join(dir, 'supabase/.temp'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'supabase/.temp/project-ref'), 'dev-ref')
  fs.writeFileSync(path.join(dir, '.env.local'), 'NEXT_PUBLIC_SUPABASE_URL=https://dev-ref.supabase.co\n')
  return dir
}
const dev = { environment: 'development', automaticMigrations: true, projectRef: 'dev-ref' }
it('confere banco do preview e ref do CLI contra autoridade remota', () => {
  const dir = workspace()
  expect(validateLocalTarget(dir, dev)).toBe('dev-ref')
  fs.writeFileSync(path.join(dir, '.env.local'), 'NEXT_PUBLIC_SUPABASE_URL=https://production-ref.supabase.co')
  expect(() => validateLocalTarget(dir, dev)).toThrow(/diverge/)
})
it('não aceita produção, desconhecido ou vínculo adulterado', () => {
  const dir = workspace()
  for (const environment of ['production', 'unknown']) expect(() => validateLocalTarget(dir, { ...dev, environment })).toThrow(/protegidos/)
  fs.writeFileSync(path.join(dir, 'supabase/.temp/project-ref'), 'other-ref')
  expect(() => validateLocalTarget(dir, dev)).toThrow(/diverge/)
})

