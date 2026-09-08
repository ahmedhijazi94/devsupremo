import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyTrustedFiles } from './trusted-validation'

// Only the trusted manifest is a fixture. File reads and integrity decisions
// execute the same descriptor reader and policy checker shipped in the CLI.
vi.mock('./generated/validation-policy', async () => {
  const { blobHash } = await import('./validation-integrity')
  return { TRUSTED_VALIDATION_POLICIES: [{ version: 'fixture', kind: 'public', files: { 'scripts/verify.mjs': blobHash('fixture validator') },
    scripts: { verify: 'node scripts/verify.mjs' }, devDependencies: {}, lock: {} }] }
})
let cwd: string
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-trusted-file-'))
  fs.mkdirSync(path.join(cwd, 'scripts'))
  fs.writeFileSync(path.join(cwd, 'scripts/verify.mjs'), 'fixture validator')
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { verify: 'node scripts/verify.mjs' } }))
  fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }))
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(cwd, { recursive: true, force: true }) })

describe('trusted validators use one descriptor snapshot', () => {
  it('uses package and lock bytes already hashed instead of reopening paths', () => {
    const open = vi.spyOn(fs, 'openSync')
    expect(() => verifyTrustedFiles(cwd)).not.toThrow()
    expect(open.mock.calls.filter(([file]) => file === path.join(cwd, 'package.json'))).toHaveLength(1)
    expect(open.mock.calls.filter(([file]) => file === path.join(cwd, 'package-lock.json'))).toHaveLength(1)
  })
  it('still rejects changed validator, missing package and unauthorized workflow', () => {
    fs.writeFileSync(path.join(cwd, 'scripts/verify.mjs'), 'changed')
    expect(() => verifyTrustedFiles(cwd)).toThrow('Validador ausente ou alterado')
    fs.writeFileSync(path.join(cwd, 'scripts/verify.mjs'), 'fixture validator')
    fs.mkdirSync(path.join(cwd, '.github/workflows'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.github/workflows/extra.yml'), 'untrusted')
    expect(() => verifyTrustedFiles(cwd)).toThrow('não autorizada')
    fs.unlinkSync(path.join(cwd, 'package.json'))
    expect(() => verifyTrustedFiles(cwd)).toThrow('obrigatório ausente')
  })
  it('rejects symlinked validators even when their bytes match the trusted digest', () => {
    const validator = path.join(cwd, 'scripts/verify.mjs')
    fs.renameSync(validator, path.join(cwd, 'target'))
    fs.symlinkSync('../target', validator)
    expect(() => verifyTrustedFiles(cwd)).toThrow()
    fs.unlinkSync(validator)
    fs.renameSync(path.join(cwd, 'scripts'), path.join(cwd, 'original-scripts'))
    fs.symlinkSync('original-scripts', path.join(cwd, 'scripts'))
    fs.copyFileSync(path.join(cwd, 'target'), path.join(cwd, 'original-scripts/verify.mjs'))
    expect(() => verifyTrustedFiles(cwd)).toThrow('link simbólico')
  })
})
