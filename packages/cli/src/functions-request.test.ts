import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseFunctionOptions, readFunctionDeployment } from './functions-request'

const entrypoint = 'supabase/functions/send-email/index.ts'
const selection = { environment: 'development', slug: 'send-email', entrypoint }
let cwd: string
function write(name: string, content = 'export const value = 1;'): void {
  fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true })
  fs.writeFileSync(path.join(cwd, name), content)
}
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-functions-files-'))
  write(entrypoint, 'import { render } from "../../../src/email.ts";\nexport { render };')
})
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }))

describe('explicit Edge Function file selection', () => {
  it('reads only selected sources and the exact selected JSON import map', () => {
    write('src/email.ts', 'export const render = () => "hello";')
    write('supabase/functions/send-email/deno.json', '{"imports":{"renderer":"../../../src/email.ts"}}')
    write('src/unrelated-app.ts', 'const unselected = "must not ship";')
    write('supabase/functions/other/index.ts', 'const unrelatedFunction = "must not ship";')
    write('.env.local', 'PRIVATE_FIXTURE=must-not-ship')
    const result = readFunctionDeployment(cwd, { ...selection, files: ['src/email.ts', entrypoint], importMap: 'supabase/functions/send-email/deno.json' })
    expect(result).toMatchObject({ ...selection, verifyJwt: true, importMap: 'supabase/functions/send-email/deno.json' })
    expect(result.files).toEqual([
      { path: entrypoint, content: fs.readFileSync(path.join(cwd, entrypoint), 'utf8') },
      { path: 'supabase/functions/send-email/deno.json', content: '{"imports":{"renderer":"../../../src/email.ts"}}' },
      { path: 'src/email.ts', content: 'export const render = () => "hello";' },
    ])
    expect(JSON.stringify(result)).not.toContain('must not ship')
    expect(JSON.stringify(result)).not.toContain('must-not-ship')
  })

  it.each([
    '../outside.ts', 'src/../../outside.ts', '/tmp/outside.ts', 'src\\outside.ts',
    'https://example.invalid/code.ts', 'tools/code.ts', 'package.json', '.env.local',
    'src/.env.json', 'src/.private/code.ts', 'src/env.json', 'src/env.local.ts',
    'src/credentials.json', 'src/private-key.json', 'src/node_modules/package/index.js',
  ])('rejects unauthorized or sensitive path %s before reading', name => {
    expect(() => parseFunctionOptions('functions-deploy', { ...selection, files: [name] })).toThrow()
    expect(() => readFunctionDeployment(cwd, { ...selection, files: [name] })).toThrow()
  })

  it.each([
    { url: 'https://foreign.example.invalid' }, { projectRef: 'foreign-ref' }, { expectedRef: 'foreign-ref' },
    { deviceSecret: 'fixture-credential' }, { serviceRole: 'fixture-credential' }, { token: 'fixture-credential' },
    { command: 'cat .env.local' }, { files: [{ path: 'src/payload.ts', content: 'untrusted queue code' }] },
  ])('rejects injected source, targets or credentials in the local selector: %j', extra => {
    expect(() => parseFunctionOptions('functions-deploy', { ...selection, ...extra })).toThrow()
  })

  it('requires the selected function entrypoint to match the slug', () => {
    expect(() => readFunctionDeployment(cwd, { ...selection, slug: 'different-function' })).toThrow(/Bundle/)
    write('src/entry.ts')
    expect(() => readFunctionDeployment(cwd, { ...selection, entrypoint: 'src/entry.ts' })).toThrow(/Bundle/)
  })

  it('rejects an import map with a source extension or a missing file', () => {
    write('src/import-map.ts', 'export default {}')
    expect(() => readFunctionDeployment(cwd, { ...selection, importMap: 'src/import-map.ts' })).toThrow(/Bundle/)
    expect(() => readFunctionDeployment(cwd, { ...selection, importMap: 'src/missing.json' })).toThrow()
  })

  it('rejects symlinked files and symlinked parent directories', () => {
    write('private/outside.ts', 'private source')
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
    fs.symlinkSync(path.join(cwd, 'private/outside.ts'), path.join(cwd, 'src/linked.ts'))
    expect(() => readFunctionDeployment(cwd, { ...selection, files: ['src/linked.ts'] })).toThrow()
    fs.symlinkSync(path.join(cwd, 'private'), path.join(cwd, 'src/linked-directory'))
    expect(() => readFunctionDeployment(cwd, { ...selection, files: ['src/linked-directory/outside.ts'] })).toThrow(/link simbólico/)
  })

  it('rejects paths that are directories and sources with null bytes', () => {
    fs.mkdirSync(path.join(cwd, 'src/directory.ts'), { recursive: true })
    expect(() => readFunctionDeployment(cwd, { ...selection, files: ['src/directory.ts'] })).toThrow(/arquivo regular/)
    write('src/null.ts', 'export const value = "\0";')
    expect(() => readFunctionDeployment(cwd, { ...selection, files: ['src/null.ts'] })).toThrow(/UTF-8/)
  })

  it('enforces 128 KiB per file in bytes, including multibyte sources', () => {
    write(entrypoint, 'a'.repeat(128 * 1024))
    expect(readFunctionDeployment(cwd, selection).files[0]!.content).toHaveLength(128 * 1024)
    write(entrypoint, 'é'.repeat(64 * 1024) + 'a')
    expect(() => readFunctionDeployment(cwd, selection)).toThrow(/orçamento/)
  })

  it('enforces 512 KiB across the selected bundle', () => {
    const files = ['src/part-a.ts', 'src/part-b.ts', 'src/part-c.ts']
    for (const name of [entrypoint, ...files]) write(name, 'a'.repeat(128 * 1024))
    expect(readFunctionDeployment(cwd, { ...selection, files }).files).toHaveLength(4)
    write('src/extra.ts', 'x')
    expect(() => readFunctionDeployment(cwd, { ...selection, files: [...files, 'src/extra.ts'] })).toThrow(/512 KiB/)
  })

  it('counts the entrypoint and import map toward the 64-file limit', () => {
    const files = Array.from({ length: 62 }, (_, index) => `src/part-${index}.ts`)
    for (const name of files) write(name)
    write('src/deno.json', '{}')
    expect(readFunctionDeployment(cwd, { ...selection, files, importMap: 'src/deno.json' }).files).toHaveLength(64)
    expect(() => readFunctionDeployment(cwd, { ...selection, files: [...files, 'src/extra.ts'], importMap: 'src/deno.json' })).toThrow(/64 arquivos/)
    expect(() => parseFunctionOptions('functions-deploy', { ...selection, files: Array(65).fill('src/same.ts') })).toThrow()
  })
})
