import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultCheckpointDeps, type CheckpointRecord } from './checkpoint'
import { validateForegroundRecovery } from './foreground-validation'
import type { FailureType } from './turn-model'
import { captureTurnCheckpoint, gitText, readJson, writeJson } from './turn-workspace'
import * as processWorker from './worker-process'
import { WorkerAbortedError } from './worker-process'

const trust = vi.hoisted(() => vi.fn())
// Execute real tools against a small fixture; immutable policy hashes have their
// own tests. Rejection at this boundary is independently exercised below.
vi.mock('./trusted-validation', () => ({ verifyTrustedFiles: trust }))
const projectId = '11111111-1111-4111-8111-111111111111'
let cwd: string
const modules = path.resolve(__dirname, '../../../node_modules')
function capture(content: string): CheckpointRecord {
  fs.writeFileSync(path.join(cwd, 'src/card.ts'), content)
  const record = captureTurnCheckpoint(cwd, { projectId, turnId: crypto.randomUUID(), summary: 'Foreground fixture', environment: 'development' })
  if (!record) throw new Error('Missing fixture checkpoint')
  return record
}
beforeEach(() => {
  trust.mockReset()
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-foreground-'))
  gitText(cwd, ['init', '-b', 'main']); gitText(cwd, ['config', 'user.name', 'Fixture']); gitText(cwd, ['config', 'user.email', 'fixture@example.invalid'])
  fs.mkdirSync(path.join(cwd, 'src'))
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'node_modules\n.env*\n.next/\n.supremo/turns/\n.supremo/validation/\n.supremo/checkpoints/\n')
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'foreground-fixture', type: 'module' }))
  writeJson(path.join(cwd, 'tsconfig.json'), { compilerOptions: { strict: true, skipLibCheck: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: [] }, include: ['src/**/*.ts'] })
  fs.writeFileSync(path.join(cwd, 'vitest.config.mjs'), "export default { cacheDir: '.supremo/validation/vite-cache', test: { include: ['src/**/*.test.ts'], pool: 'forks', maxWorkers: 1, minWorkers: 1, coverage: { provider: 'v8', include: ['src/card.ts'], thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 } } } }\n")
  fs.writeFileSync(path.join(cwd, 'eslint.config.mjs'), "export default [{ ignores: ['.supremo/**', 'node_modules/**'] }, { files: ['**/*.js'], rules: { 'no-undef': 'error' } }]\n")
  fs.writeFileSync(path.join(cwd, 'src/card.ts'), 'export const value = 0;\n')
  fs.symlinkSync(modules, path.join(cwd, 'node_modules'), 'dir')
  gitText(cwd, ['add', '-A']); gitText(cwd, ['commit', '-m', 'fixture'])
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(cwd, { recursive: true, force: true }) })

describe('foreground recovery on immutable copies', () => {
  it('finds invalid TypeScript in a test file and leaves checkpoint publication pending', async () => {
    fs.writeFileSync(path.join(cwd, 'src/card.test.ts'), "export const expected: number = 'invalid';\n")
    const record = capture('export const value = 1;\n')
    const queue = defaultCheckpointDeps(cwd).readQueue()
    const worker = vi.spyOn(processWorker, 'runWorkerProcess')
    const evidence = await validateForegroundRecovery(cwd, record, ['typecheck'])
    expect(evidence).toMatchObject({ status: 'failed', sha: record.commitSha, fingerprint: record.treeSha,
      checks: [{ name: 'foreground typecheck', type: 'typecheck', status: 'failed' }] })
    expect(evidence.logs).toContain('src/card.test.ts')
    expect(evidence.logs).toContain('TS2322')
    expect(worker).toHaveBeenCalledTimes(1)
    expect(worker.mock.calls[0]?.[1]).toEqual([path.join(cwd, 'node_modules/typescript/bin/tsc'), '--noEmit', '--incremental', 'false'])
    expect(defaultCheckpointDeps(cwd).readQueue()).toEqual(queue)
    expect(readJson(path.join(cwd, '.supremo/validation', `${evidence.id}.json`))).toBeNull()
    expect(readJson(path.join(cwd, '.supremo/validation/foreground', `${evidence.id}.json`))).toEqual(evidence)
    expect(fs.existsSync(path.join(cwd, 'tsconfig.tsbuildinfo'))).toBe(false)
  })

  it('generates Next route types in the snapshot and preserves live development declarations', async () => {
    const nextVersion = (JSON.parse(fs.readFileSync(path.join(modules, 'next/package.json'), 'utf8')) as { version: string }).version
    writeJson(path.join(cwd, 'package.json'), { name: 'foreground-next-fixture', type: 'module', dependencies: { next: nextVersion } })
    writeJson(path.join(cwd, 'tsconfig.json'), { compilerOptions: { target: 'ES2022', lib: ['dom', 'dom.iterable', 'esnext'],
      allowJs: true, skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler',
      resolveJsonModule: true, isolatedModules: true, jsx: 'react-jsx', incremental: true, plugins: [{ name: 'next' }] },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'], exclude: ['node_modules', 'vitest.config.mjs'] })
    fs.mkdirSync(path.join(cwd, 'app'))
    fs.writeFileSync(path.join(cwd, 'app/page.tsx'), 'export default function Page() { return <main>Hello</main> }\n')
    fs.writeFileSync(path.join(cwd, 'app/layout.tsx'), "import type { ReactNode } from 'react'; export default function Layout({children}: {children: ReactNode}) { return <html><body>{children}</body></html> }\n")
    const declarations = '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\nimport "./.next/dev/types/routes.d.ts";\nimport "./.next/dev/types/root-params.d.ts";\n'
    fs.writeFileSync(path.join(cwd, 'next-env.d.ts'), declarations)
    fs.mkdirSync(path.join(cwd, '.next/dev/types'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.next/dev/types/routes.d.ts'), 'export {}\n')
    fs.writeFileSync(path.join(cwd, '.next/dev/types/root-params.d.ts'), 'export {}\n')
    const record = capture('export const value = 1;\n')
    const configuration = fs.readFileSync(path.join(cwd, 'tsconfig.json'), 'utf8')
    const worker = vi.spyOn(processWorker, 'runWorkerProcess')
    const evidence = await validateForegroundRecovery(cwd, record, ['typecheck'])
    expect(evidence, evidence.logs).toMatchObject({ status: 'passed', sha: record.commitSha, fingerprint: record.treeSha })
    expect(worker).toHaveBeenCalledTimes(2)
    expect(worker.mock.calls[0]?.[1]).toEqual([path.join(cwd, 'node_modules/next/dist/bin/next'), 'typegen'])
    expect(fs.readFileSync(path.join(cwd, 'next-env.d.ts'), 'utf8')).toBe(declarations)
    expect(fs.readFileSync(path.join(cwd, 'tsconfig.json'), 'utf8')).toBe(configuration)
    expect(fs.readFileSync(path.join(cwd, '.next/dev/types/routes.d.ts'), 'utf8')).toBe('export {}\n')
    expect(fs.existsSync(path.join(cwd, '.next/types'))).toBe(false)
    expect(defaultCheckpointDeps(cwd).readQueue().at(-1)?.validationStatus).toBe('pending')
  }, 15_000)

  it('awaits asynchronous unit/integration failures and fixes while preserving the preview, HEAD and index', async () => {
    fs.writeFileSync(path.join(cwd, 'src/card.test.ts'), `import { test, expect } from 'vitest';
import fs from 'node:fs';
import { value } from './card';
test('asynchronous result', async () => {
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(process.env.FOREGROUND_PRIVATE_FIXTURE).toBeUndefined();
  expect(fs.existsSync('.env.local')).toBe(false);
  expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBe('http://127.0.0.1:9');
  expect(value).toBe(2);
});\n`)
    fs.writeFileSync(path.join(cwd, 'src/unrelated.rls.test.ts'), "throw new Error('RLS must not execute during a local recovery');\n")
    fs.writeFileSync(path.join(cwd, '.env.local'), 'FOREGROUND_PRIVATE_FIXTURE=private-fixture\n')
    fs.mkdirSync(path.join(cwd, '.next')); fs.writeFileSync(path.join(cwd, '.next/preview'), 'healthy preview')
    const previousPrivate = process.env.FOREGROUND_PRIVATE_FIXTURE
    process.env.FOREGROUND_PRIVATE_FIXTURE = 'private-fixture'
    const preview = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'pipe'] })
    await once(preview.stdout, 'data')
    const previewPid = preview.pid
    if (!previewPid) throw new Error('Missing preview process')
    const head = gitText(cwd, ['rev-parse', 'HEAD']), index = fs.readFileSync(path.join(cwd, '.git/index'))
    const worker = vi.spyOn(processWorker, 'runWorkerProcess')
    try {
      const failedRecord = capture('export const value = 1;\n')
      const running = validateForegroundRecovery(cwd, failedRecord, ['unit', 'integration'])
      expect(preview.exitCode).toBeNull()
      expect(() => process.kill(previewPid, 0)).not.toThrow()
      const failed = await running
      expect(failed.status).toBe('failed')
      expect(failed.logs).toContain('asynchronous result')
      expect(failed.checks).toEqual([{ name: 'foreground unit', type: 'unit', status: 'failed' }, { name: 'foreground integration', type: 'integration', status: 'failed' }])
      const fixedRecord = capture('export const value = 2;\n')
      const queue = defaultCheckpointDeps(cwd).readQueue()
      const fixed = await validateForegroundRecovery(cwd, fixedRecord, ['unit', 'integration'])
      expect(fixed.status).toBe('passed')
      expect(fixed.summary).toContain('Evidência parcial')
      expect(worker).toHaveBeenCalledTimes(2)
      expect(worker.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--coverage', '--coverage.reportsDirectory']))
      expect(defaultCheckpointDeps(cwd).readQueue()).toEqual(queue)
      expect(preview.pid).toBe(previewPid)
      expect(preview.exitCode).toBeNull()
      expect(() => process.kill(previewPid, 0)).not.toThrow()
      expect(gitText(cwd, ['rev-parse', 'HEAD'])).toBe(head)
      expect(fs.readFileSync(path.join(cwd, '.git/index'))).toEqual(index)
      expect(fs.readFileSync(path.join(cwd, '.next/preview'), 'utf8')).toBe('healthy preview')
      expect(fs.readFileSync(path.join(cwd, 'src/card.ts'), 'utf8')).toBe('export const value = 2;\n')
      expect(fs.readdirSync(path.join(cwd, '.supremo/validation')).some(file => file.startsWith('foreground-work-'))).toBe(false)
    } finally {
      if (previousPrivate === undefined) delete process.env.FOREGROUND_PRIVATE_FIXTURE
      else process.env.FOREGROUND_PRIVATE_FIXTURE = previousPrivate
      const closed = once(preview, 'exit')
      preview.kill('SIGTERM')
      await closed
    }
  }, 20_000)

  it('executes only the fixed lint command for lint failures', async () => {
    fs.writeFileSync(path.join(cwd, 'src/broken.js'), 'missingFunction();\n')
    const record = capture('export const value = 1;\n')
    const evidence = await validateForegroundRecovery(cwd, record, ['lint'])
    expect(evidence.status).toBe('failed')
    expect(evidence.checks).toEqual([{ name: 'foreground lint', type: 'lint', status: 'failed' }])
    expect(evidence.logs).toContain('no-undef')
  })

  it('keeps a unit recovery failed when tests pass but the original coverage threshold fails', async () => {
    fs.writeFileSync(path.join(cwd, 'src/card.test.ts'), "import { test, expect } from 'vitest'; import { value } from './card'; test('correct value', () => expect(value).toBe(2));\n")
    const record = capture('export const value = 2;\nexport function untested() {\n  return 3;\n}\n')
    const evidence = await validateForegroundRecovery(cwd, record, ['unit'])
    expect(evidence.status).toBe('failed')
    expect(evidence.logs).toContain('1 passed')
    expect(evidence.logs).toMatch(/coverage.*threshold/i)
    expect(defaultCheckpointDeps(cwd).readQueue().at(-1)?.validationStatus).toBe('pending')
    expect(fs.existsSync(path.join(cwd, 'coverage'))).toBe(false)
  })

  it('classifies missing executables as an external dependency before running any command', async () => {
    const record = capture('export const value = 1;\n')
    fs.unlinkSync(path.join(cwd, 'node_modules'))
    fs.mkdirSync(path.join(cwd, 'node_modules'))
    const worker = vi.spyOn(processWorker, 'runWorkerProcess')
    const evidence = await validateForegroundRecovery(cwd, record, ['typecheck'])
    expect(evidence).toMatchObject({ status: 'failed', checks: [{ type: 'external_dependency', status: 'failed' }] })
    expect(evidence.logs).toContain('typescript/bin/tsc')
    expect(worker).not.toHaveBeenCalled()
  })

  it.each(([[], ['security'], ['typecheck', 'rls'], ['build']] satisfies FailureType[][]).map(types => ({ types })))('refuses unsupported or empty scope $types before executing any tool', async ({ types }) => {
    const worker = vi.spyOn(processWorker, 'runWorkerProcess')
    const evidence = await validateForegroundRecovery(cwd, capture('export const value = 1;\n'), types)
    expect(evidence.status).toBe('failed')
    expect(worker).not.toHaveBeenCalled()
  })

  it('refuses altered trusted files and a mismatch between the record and immutable tree', async () => {
    const record = capture('export const value = 1;\n')
    const worker = vi.spyOn(processWorker, 'runWorkerProcess')
    trust.mockImplementation(() => { throw new Error('Protected validator differs') })
    expect((await validateForegroundRecovery(cwd, record, ['typecheck'])).status).toBe('failed')
    expect((await validateForegroundRecovery(cwd, { ...record, treeSha: 'a'.repeat(40) }, ['typecheck'])).status).toBe('failed')
    expect(worker).not.toHaveBeenCalled()
  })

  it('refuses a tracked Next output symlink before it can write into the active preview', async () => {
    const preview = path.join(cwd, '.supremo/validation/preview-output')
    fs.mkdirSync(preview, { recursive: true })
    fs.writeFileSync(path.join(preview, 'healthy'), 'unchanged')
    fs.symlinkSync(preview, path.join(cwd, '.next'), 'dir')
    writeJson(path.join(cwd, 'package.json'), { name: 'foreground-symlink-fixture', type: 'module', dependencies: { next: '16.3.3' } })
    const record = capture('export const value = 1;\n')
    const worker = vi.spyOn(processWorker, 'runWorkerProcess')
    const evidence = await validateForegroundRecovery(cwd, record, ['typecheck'])
    expect(evidence).toMatchObject({ status: 'failed', checks: [{ type: 'security', status: 'failed' }] })
    expect(evidence.logs).toContain('link simbólico')
    expect(worker).not.toHaveBeenCalled()
    expect(fs.readdirSync(preview)).toEqual(['healthy'])
    expect(fs.readFileSync(path.join(preview, 'healthy'), 'utf8')).toBe('unchanged')
  })

  it('rejects a passing command which changed the isolated source tree', async () => {
    const record = capture('export const value = 1;\n')
    vi.spyOn(processWorker, 'runWorkerProcess').mockImplementation(async (_executable, _args, options) => {
      fs.writeFileSync(path.join(options.cwd, 'src/card.ts'), 'export const value = 9;\n')
      return { stdout: '', stderr: '' }
    })
    const evidence = await validateForegroundRecovery(cwd, record, ['unit'])
    expect(evidence.status).toBe('failed')
    expect(evidence.logs).toContain('alterou o snapshot')
    expect(fs.readFileSync(path.join(cwd, 'src/card.ts'), 'utf8')).toBe('export const value = 1;\n')
  })

  it('sanitizes failing output and cleans up an aborted recovery without approving publication', async () => {
    const record = capture('export const value = 1;\n')
    const credential = ['ghp', 'syntheticFixtureNotARealCredential'].join('_')
    const worker = vi.spyOn(processWorker, 'runWorkerProcess').mockRejectedValue(Object.assign(new Error('Check failed'), { stderr: `token=${credential}` }))
    const evidence = await validateForegroundRecovery(cwd, record, ['unit'])
    expect(evidence.logs).not.toContain(credential)
    expect(evidence.logs).toContain('[REDACTED]')
    worker.mockRejectedValue(new WorkerAbortedError())
    await expect(validateForegroundRecovery(cwd, record, ['unit'])).rejects.toBeInstanceOf(WorkerAbortedError)
    expect(defaultCheckpointDeps(cwd).readQueue().at(-1)?.validationStatus).toBe('pending')
    expect(fs.readdirSync(path.join(cwd, '.supremo/validation')).some(file => file.startsWith('foreground-work-'))).toBe(false)
  })

  it('preserves the final failure in long output after redacting the entire diagnostic', async () => {
    const record = capture('export const value = 1;\n')
    const credential = ['ghp', 'syntheticFixtureNotARealCredential'].join('_')
    vi.spyOn(processWorker, 'runWorkerProcess').mockRejectedValue(Object.assign(new Error('Check failed'), {
      stdout: `Initial context\n${'passed check\n'.repeat(1400)}`,
      stderr: `credential ${credential}\nFINAL ERROR: coverage below required threshold`,
    }))
    const evidence = await validateForegroundRecovery(cwd, record, ['unit'])
    expect(evidence.logs.length).toBeLessThanOrEqual(8000)
    expect(evidence.logs).toContain('Initial context')
    expect(evidence.logs).toContain('FINAL ERROR: coverage below required threshold')
    expect(evidence.logs).toContain('[REDACTED]')
    expect(evidence.logs).not.toContain(credential)
    expect(JSON.stringify(readJson(path.join(cwd, '.supremo/validation/foreground', `${evidence.id}.json`)))).not.toContain(credential)
  })

  it.each(['timeout', 'output'] as const)('keeps the actual subprocess diagnostic when the %s limit stops it', async limit => {
    const record = capture('export const value = 1;\n')
    const credential = ['ghp', 'syntheticFixtureNotARealCredential'].join('_')
    const run = processWorker.runWorkerProcess
    vi.spyOn(processWorker, 'runWorkerProcess').mockImplementation((_executable, _args, options) => run(process.execPath, ['-e',
      `process.stderr.write(${JSON.stringify(`credential ${credential}\nFINAL ERROR: previous check failed\n`)}); ${limit === 'output' ? "setTimeout(() => process.stdout.write('x'.repeat(10000)), 50);" : ''} setInterval(() => {}, 1000);`,
    ], { ...options, timeoutMs: limit === 'timeout' ? 750 : 2000, maxOutputBytes: limit === 'output' ? 256 : 4096 }))
    const evidence = await validateForegroundRecovery(cwd, record, ['unit'])
    expect(evidence.status).toBe('failed')
    expect(evidence.logs).toContain('FINAL ERROR: previous check failed')
    expect(evidence.logs).toContain('[REDACTED]')
    expect(evidence.logs).not.toContain(credential)
    expect(evidence.logs).toContain(limit === 'timeout' ? 'tempo permitido' : 'limite de saída')
  })
})
