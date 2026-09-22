import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { sanitizeDiagnostic } from '../../../src/lib/checkpoint/feedback'
import type { CheckpointRecord } from './checkpoint'
import { readEnginePolicy } from './engine-policy'
import { isKnownNextTsconfigNoise } from './restore'
import { readStableFile } from './stable-file'
import type { FailureType } from './turn-model'
import { localEvidenceSchema, scanCheckpointForUpload, VALIDATION_DIR, type LocalEvidence } from './turn-validation'
import { captureTree, gitText, writeJson } from './turn-workspace'
import { verifyTrustedFiles } from './trusted-validation'
import { runWorkerProcess, WorkerAbortedError } from './worker-process'
import { linkIsolatedDependencies, readProjectStack, routePreparation, syntheticValidationEnvironment } from './framework-runtime'

const supportedType = z.enum(['typecheck', 'lint', 'unit', 'integration'])
type SupportedType = z.infer<typeof supportedType>
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/)

/** Local proof for selected previous failures only. Never approves or changes the
 * publication queue; foreground evidence is stored outside its evidence lookup. */
export async function validateForegroundRecovery(
  cwd: string, record: CheckpointRecord, types: readonly FailureType[], signal?: AbortSignal,
): Promise<LocalEvidence> {
  const sha = shaSchema.parse(record.commitSha)
  const fingerprint = gitText(cwd, ['rev-parse', `${sha}^{tree}`])
  const baseSha = record.changesetBaseSha ? shaSchema.parse(record.changesetBaseSha) : gitText(cwd, ['rev-parse', `${sha}^`])
  const startedAt = new Date().toISOString(), id = crypto.randomUUID()
  const limits = readEnginePolicy(cwd).validation, deadline = Date.now() + limits.timeout_ms
  const scratch = path.join(cwd, VALIDATION_DIR, `foreground-work-${id}`)
  let added = false
  const diagnostics: string[] = [], failedDiagnostics: string[] = []
  const log = (output: string, failed = false): void => {
    const sanitized = sanitizeDiagnostic(output, output.length)
    diagnostics.push(sanitized)
    if (failed) failedDiagnostics.push(sanitized)
  }
  let expectedTree = fingerprint
  let status: LocalEvidence['status'] = 'failed'
  const checks: LocalEvidence['checks'] = []
  let failureType: FailureType = 'unknown'
  try {
    const selected = [...new Set(z.array(supportedType).min(1).max(100).parse(types))]
    if (record.environment !== 'development') throw new Error('Recuperação local exige ambiente development.')
    if (record.treeSha && record.treeSha !== fingerprint) throw new Error('Snapshot diverge da revisão de recuperação.')
    if (signal?.aborted) throw new WorkerAbortedError()
    failureType = 'security'
    if (scanCheckpointForUpload(cwd, record).status === 'failed') throw new Error('Snapshot contém segredo ou arquivo privado; execução recusada.')
    if (gitText(cwd, ['ls-tree', '-r', '-z', sha]).split('\0').some(entry => entry.startsWith('120000 '))) {
      throw new Error('Snapshot de recuperação contém link simbólico; execução isolada recusada.')
    }
    fs.mkdirSync(path.dirname(scratch), { recursive: true, mode: 0o700 })
    execFileSync('git', ['worktree', 'add', '--detach', scratch, sha], { cwd, stdio: 'pipe' })
    added = true
    verifyTrustedFiles(scratch)
    const stack = readProjectStack(scratch)
    failureType = 'external_dependency'
    linkIsolatedDependencies(cwd, scratch)
    const privateRoot = path.join(scratch, VALIDATION_DIR)
    const home = path.join(privateRoot, 'home'), temp = path.join(privateRoot, 'tmp')
    fs.mkdirSync(home, { recursive: true, mode: 0o700 }); fs.mkdirSync(temp, { recursive: true, mode: 0o700 })
    const env: NodeJS.ProcessEnv = {
      PATH: `${path.join(cwd, 'node_modules/.bin')}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp, CI: 'true',
      NEXT_TELEMETRY_DISABLED: '1', SUPREMO_VALIDATION: '1',
      ...syntheticValidationEnvironment(stack),
    }
    let remainingOutput = limits.max_output_bytes
    const needsRoutes = selected.includes('typecheck') || (stack === 'tanstack-start-vite' && selected.some(type => type === 'unit' || type === 'integration'))
    const preparation = needsRoutes ? routePreparation(stack, cwd, scratch) : null
    const required = [
      ...(selected.includes('typecheck') ? ['typescript/bin/tsc'] : []),
      ...(selected.includes('lint') ? ['eslint/bin/eslint.js'] : []),
      ...(selected.some(type => type === 'unit' || type === 'integration') ? ['vitest/vitest.mjs', '@vitest/coverage-v8/package.json'] : []),
      ...(preparation && stack === 'nextjs' ? ['next/dist/bin/next'] : []),
    ]
    for (const file of required) {
      if (!fs.statSync(path.join(cwd, 'node_modules', file), { throwIfNoEntry: false })?.isFile()) throw new Error(`Dependência local indisponível: ${file}`)
    }
    if (preparation) {
      // Route declarations are generated in the immutable snapshot, without
      // starting the preview, editing its artifacts or running a full build.
      if (stack === 'nextjs') {
        const nextEnv = path.join(scratch, 'next-env.d.ts')
        if (fs.lstatSync(nextEnv, { throwIfNoEntry: false })) readStableFile(nextEnv, 64 * 1024, scratch)
      }
      failureType = 'typecheck'
      const result = await runWorkerProcess(process.execPath, [preparation.command, ...preparation.args], {
        cwd: scratch, env, timeoutMs: Math.max(1, deadline - Date.now()), maxOutputBytes: remainingOutput, signal,
      })
      const output = `${result.stdout}\n${result.stderr}`
      remainingOutput -= Buffer.byteLength(output)
      log(`${stack === 'nextjs' ? 'next typegen' : 'routes:generate'}\n${output}`)
      failureType = 'security'
      const prepared = captureTree(scratch)
      const changed = gitText(scratch, ['diff', '--name-only', '-z', fingerprint, prepared.treeSha]).split('\0').filter(Boolean)
      if (prepared.headSha !== sha || changed.some(file => stack !== 'nextjs' || (file !== 'next-env.d.ts' && !(file === 'tsconfig.json' && isKnownNextTsconfigNoise(
        gitText(scratch, ['show', `${sha}:tsconfig.json`]), readStableFile(path.join(scratch, file), 256 * 1024, scratch).content,
      ))))) throw new Error('Geração de tipos alterou a implementação ou configuração protegida.')
      expectedTree = prepared.treeSha
    }
    const commands: { types: SupportedType[]; executable: string; args: string[] }[] = []
    const executable = (file: string): string => path.join(cwd, 'node_modules', file)
    if (selected.includes('typecheck')) commands.push({ types: ['typecheck'], executable: executable('typescript/bin/tsc'), args: ['--noEmit', '--incremental', 'false'] })
    if (selected.includes('lint')) commands.push({ types: ['lint'], executable: executable('eslint/bin/eslint.js'), args: ['.'] })
    const testTypes = selected.filter(type => type === 'unit' || type === 'integration')
    if (testTypes.length) commands.push({ types: testTypes, executable: executable('vitest/vitest.mjs'),
      args: ['run', '--coverage', '--coverage.reportsDirectory', path.join(privateRoot, 'coverage'), '--exclude', '**/*.rls.test.ts'] })
    failureType = 'external_dependency'
    for (const command of commands) {
      if (signal?.aborted) throw new WorkerAbortedError()
      if (Date.now() >= deadline || remainingOutput <= 0) throw new Error('Recuperação local excedeu seu orçamento de execução.')
      let commandStatus: 'passed' | 'failed' = 'passed'
      let output = ''
      try {
        const result = await runWorkerProcess(process.execPath, [command.executable, ...command.args], {
          cwd: scratch, env, timeoutMs: Math.max(1, deadline - Date.now()), maxOutputBytes: remainingOutput, signal,
        })
        output = `${result.stdout}\n${result.stderr}`
      } catch (error) {
        if (error instanceof WorkerAbortedError) throw error
        commandStatus = 'failed'
        const failure = error as Error & { stdout?: string; stderr?: string }
        output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}\n${failure.message}`
      }
      remainingOutput -= Buffer.byteLength(output)
      log(`${command.types.join('/')}\n${output}`, commandStatus === 'failed')
      for (const type of command.types) checks.push({ name: `foreground ${type}`, type, status: commandStatus })
    }
    failureType = 'security'
    const after = captureTree(scratch)
    if (after.headSha !== sha || after.treeSha !== expectedTree) throw new Error('Validação alterou o snapshot; prova de recuperação recusada.')
    status = checks.every(check => check.status === 'passed') ? 'passed' : 'failed'
  } catch (error) {
    if (error instanceof WorkerAbortedError) throw error
    checks.push({ name: 'foreground recovery integrity', type: failureType, status: 'failed' })
    const failure = error as Error & { stdout?: string; stderr?: string }
    log(`${failure?.stdout ?? ''}\n${failure?.stderr ?? ''}\n${error instanceof Error ? error.message : String(error)}`, true)
  } finally {
    if (added) {
      try { execFileSync('git', ['worktree', 'remove', '--force', scratch], { cwd, stdio: 'pipe' }) }
      catch { log('Limpeza da cópia de recuperação pendente; workspace preservado.', true) }
    }
  }
  const diagnostic = (failedDiagnostics.length ? failedDiagnostics : diagnostics).join('\n')
  const logs = diagnostic.length > 8000
    ? `${diagnostic.slice(0, 3500)}\n[... saída intermediária omitida ...]\n${diagnostic.slice(-4000)}` : diagnostic
  const evidence = localEvidenceSchema.parse({ id, projectId: record.projectId, checkpointId: record.checkpointId,
    sha, fingerprint, baseSha, environment: record.environment ?? 'unknown', status, startedAt, finishedAt: new Date().toISOString(),
    criterionIds: [], acceptanceCriteria: [], logs, checks,
    summary: status === 'passed' ? 'Falhas locais solicitadas verificadas. Evidência parcial; publicação e CI continuam pendentes.'
      : 'Recuperação local não comprovada; diagnóstico preservado, publicação e CI continuam pendentes.',
  })
  writeJson(path.join(cwd, VALIDATION_DIR, 'foreground', `${id}.json`), evidence)
  return evidence
}
