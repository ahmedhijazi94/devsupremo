import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'
import { expect, it } from 'vitest'
import pkg from '../package.json'

it('ships a standalone CLI with one Zod copy and validates with dynamic code generation disabled', () => {
  const root = path.resolve(__dirname, '..')
  const cwd = mkdtempSync(path.join(tmpdir(), 'supremo-jitless-'))
  try {
    // This alias is part of the shipped build command, not a test-only patch.
    expect(pkg.scripts.build).toContain(
      '--alias:zod=./node_modules/zod/index.js',
    )
    const options = {
      absWorkingDir: root,
      bundle: true,
      platform: 'node' as const,
      target: 'node18',
      supported: { 'template-literal': false },
      alias: { zod: './node_modules/zod/index.js' },
      metafile: true,
    }
    const bin = path.join(cwd, 'supremo.cjs')
    const result = buildSync({
      ...options,
      entryPoints: ['src/bin.ts'],
      outfile: bin,
    })
    const zodCopies = Object.keys(result.metafile!.inputs).filter((file) =>
      /(?:^|\/)zod\/v4\/core\/versions\.js$/.test(file),
    )
    expect(zodCopies).toEqual(['node_modules/zod/v4/core/versions.js'])
    const noCodegen = [
      '--disallow-code-generation-from-strings',
      '--require',
      path.join(root, 'src/fixtures/no-codegen-preload.cjs'),
    ]
    const run = (args: string[]) =>
      execFileSync(process.execPath, [...noCodegen, bin, ...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
    expect(run(['--version'])).toBe(pkg.version)
    expect(run(['--help'])).toContain('Supremo')
    // Real CLI dispatch + typed local policy reads/mutations, no daemon/network.
    mkdirSync(path.join(cwd, '.supremo'))
    writeFileSync(
      path.join(cwd, '.supremo/project.json'),
      '{"projectId":"11111111-1111-4111-8111-111111111111"}',
    )
    expect(JSON.parse(run(['engine', 'status']))).toMatchObject({
      policy: { validation_mode: 'background_adaptive' },
    })
    expect(JSON.parse(run(['engine', 'on-request']))).toMatchObject({
      policy: { validation_mode: 'on_request' },
    })
    expect(
      JSON.parse(
        readFileSync(path.join(cwd, '.supremo/lifecycle.json'), 'utf8'),
      ),
    ).toMatchObject({ validation_mode: 'on_request' })
    const probe = path.join(cwd, 'probe.cjs')
    buildSync({
      ...options,
      entryPoints: ['src/fixtures/zod-jitless-probe.ts'],
      outfile: probe,
    })
    const output = execFileSync(process.execPath, [...noCodegen, probe], {
      cwd,
      encoding: 'utf8',
    })
    expect(JSON.parse(output)).toMatchObject({
      jitless: true,
      dynamicCodeAttempts: 0,
      maliciousKeysAndPayloads: 'checked',
      sharedProjectPolicies: 'checked',
    })
    // No runtime node_modules alongside the distributed files.
    writeFileSync(path.join(cwd, 'package.json'), '{"private":true}')
    expect(run(['--version'])).toBe(pkg.version)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}, 20000)
