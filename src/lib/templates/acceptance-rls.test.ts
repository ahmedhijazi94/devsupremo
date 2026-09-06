import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { describe, expect, it } from 'vitest'
import { buildProjectFiles } from './project-files'
import { isolationGateFiles } from './isolation-gate'

const projectId = '00000000-0000-4000-8000-000000000001'
type Scenario = 'pass' | 'fail' | 'skip' | 'todo' | 'empty' | 'excluded' | 'wrong-sha' | 'remote-db' | 'missing-file' | 'mixed' | 'no-contract' | 'supabase'
interface AcceptanceReport {
  version: number; projectId: string; sha: string; runId: number; runAttempt: number
  checks: Array<{ name: string; type: string; status: string }>; criterionIds: string[]
}

async function executeAcceptance(scenario: Scenario): Promise<{ code: number | null; report: AcceptanceReport | null; requests: number; sha: string; output: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-acceptance-test-'))
  let requests = 0
  const server = http.createServer((_request, response) => {
    requests++
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ visibleTo: ['owner'] }))
  })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture server not listening')
    fs.mkdirSync(path.join(root, 'scripts'))
    fs.mkdirSync(path.join(root, '.supremo'))
    fs.mkdirSync(path.join(root, 'tests'))
    fs.mkdirSync(path.join(root, 'supabase'))
    fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(root, 'node_modules'), 'dir')
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.supremo/acceptance-result/\n')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    fs.writeFileSync(path.join(root, 'vitest.config.mjs'), `export default { test: { environment: 'node', include: ['**/*.test.ts'], exclude: ${JSON.stringify(scenario === 'excluded' ? ['tests/ownership.rls.test.ts'] : [])} } }`)
    fs.writeFileSync(path.join(root, '.supremo/project.json'), JSON.stringify({ projectId }))
    const file = isolationGateFiles().find((item) => item.path === 'scripts/acceptance-rls.mjs')!
    fs.writeFileSync(path.join(root, file.path), file.content)
    const behavior = "it('executes the named behavioral request', async () => { const response = await fetch(process.env.SUPABASE_URL!); expect(await response.json()).toEqual({visibleTo:['owner']}) })"
    const test = scenario === 'empty' ? 'export const noTests = true' : "import { it, expect } from 'vitest'\n" +
      (scenario === 'fail' ? "it('known failure', () => expect(2).toBe(3))" : behavior) +
      (scenario === 'skip' ? "\nit.skip('missing proof', () => expect(true).toBe(true))" : '') +
      (scenario === 'todo' ? "\nit.todo('missing proof')" : '')
    const proofFile = scenario === 'supabase' ? 'supabase/ownership.rls.test.ts' : 'tests/ownership.rls.test.ts'
    fs.writeFileSync(path.join(root, proofFile), test)
    if (scenario !== 'no-contract') fs.writeFileSync(path.join(root, '.supremo/acceptance.json'), JSON.stringify({
      version: 1, criteria: [{ id: 'ownership', description: 'owner access is proven', requiredChecks: ['owner-access', ...(scenario === 'mixed' ? ['ui-form'] : [])] }],
      checks: [{ name: 'owner-access', type: 'rls', files: [proofFile, ...(scenario === 'missing-file' ? ['tests/absent.rls.test.ts'] : [])] },
        ...(scenario === 'mixed' ? [{ name: 'ui-form', type: 'e2e', files: ['e2e/form.spec.ts'] }] : [])],
    }))
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'acceptance fixture'], { cwd: root })
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/acceptance-rls.mjs'], { cwd: root, env: { ...process.env,
        SUPREMO_ACCEPTANCE_SHA: scenario === 'wrong-sha' ? 'a'.repeat(40) : sha, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2',
        SUPABASE_URL: scenario === 'remote-db' ? 'https://production.example.invalid' : `http://127.0.0.1:${address.port}`,
        SUPABASE_ANON_KEY: 'ephemeral-test-only', SUPABASE_SERVICE_ROLE_KEY: 'ephemeral-test-only',
      }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.once('error', reject)
      child.once('exit', (code) => resolve({ code, output }))
    })
    const destination = path.join(root, '.supremo/acceptance-result/acceptance.json')
    return { ...result, report: fs.existsSync(destination) ? JSON.parse(fs.readFileSync(destination, 'utf8')) as AcceptanceReport : null, requests, sha }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe('named RLS acceptance executes actual Vitest proofs', () => {
  it('can name the native scaffold isolation tests under supabase/', async () => {
    const result = await executeAcceptance('supabase')
    expect(result.code, result.output).toBe(0)
    expect(result.requests).toBe(1)
    expect(result.report?.checks).toEqual([{ name: 'owner-access', type: 'rls', status: 'passed' }])
  }, 20_000)
  it('publishes only proofs that executed, linked to project, exact SHA and workflow attempt', async () => {
    const result = await executeAcceptance('pass')
    expect(result.code, result.output).toBe(0)
    expect(result.requests).toBe(1)
    expect(result.report).toMatchObject({ version: 1, projectId, sha: result.sha, runId: 42, runAttempt: 2,
      checks: [{ name: 'owner-access', type: 'rls', status: 'passed' }], criterionIds: ['ownership'] })
  }, 20_000)
  it.each(['fail', 'skip', 'todo', 'empty', 'excluded', 'missing-file'] as const)('%s never becomes a named passing proof', async (scenario) => {
    const result = await executeAcceptance(scenario)
    expect(result.code).not.toBe(0)
    expect(result.report?.checks.some((check) => check.status === 'passed')).toBe(false)
    expect(result.report?.criterionIds).toEqual([])
  }, 20_000)
  it.each(['wrong-sha', 'remote-db'] as const)('%s is rejected before tests or requests execute', async (scenario) => {
    const result = await executeAcceptance(scenario)
    expect(result.code).not.toBe(0)
    expect(result.requests).toBe(0)
  }, 20_000)
  it('does not attribute a mixed criterion to its RLS subset', async () => {
    const result = await executeAcceptance('mixed')
    expect(result.code, result.output).toBe(0)
    expect(result.report?.checks).toEqual([{ name: 'owner-access', type: 'rls', status: 'passed' }])
    expect(result.report?.criterionIds).toEqual([])
  }, 20_000)
  it('does not invent an acceptance artifact without a contract', async () => {
    const result = await executeAcceptance('no-contract')
    expect(result.code).toBe(0)
    expect(result.report).toBeNull()
    expect(result.requests).toBe(0)
  }, 20_000)
})

describe('acceptance evidence is part of the mandatory RLS job', () => {
  it('current contracts activate database checks and artifacts use the exact PR head', () => {
    const files = buildProjectFiles({ projectName: 'acceptance', description: '', projectId })
    const workflow = files.find((file) => file.path === '.github/workflows/ci.yml')!.content
    expect(workflow).toContain("steps.acceptance.outputs.rls == 'true'")
    expect(workflow).toContain("- '.supremo/acceptance.json'")
    const job = workflow.slice(workflow.indexOf('  rls:'), workflow.indexOf('  dependencies:'))
    expect(job).toContain('run: node scripts/acceptance-rls.mjs')
    expect(job).toContain('ref: ${{ github.event.pull_request.head.sha || github.sha }}')
    expect(job).toContain('name: supremo-acceptance-${{ github.event.pull_request.head.sha || github.sha }}')
    expect(job).toContain('path: .supremo/acceptance-result/acceptance.json')
    expect(job).not.toContain('continue-on-error')
    expect(workflow).toContain("if: needs.rls.result != 'success'")
  })
})
