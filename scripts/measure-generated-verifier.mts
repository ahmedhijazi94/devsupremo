/** Compare the actual full verifier, never a sum of independent gate times.
 * Requires an installed disposable frozen Next fixture and isolated native
 * Supabase test services. Does not migrate/reset databases or change gates.
 * NEXT_RUNTIME_REFERENCE=/tmp/... TEST_SUPABASE_CONFIG=/tmp/...json
 * node --import tsx scripts/measure-generated-verifier.mts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createServer } from 'node:net'
import { z } from 'zod'
import { buildProjectFiles } from '../src/lib/templates/project-files'

const workspace = mkdtempSync(join(tmpdir(), 'supremo-full-verifier-'))
const reference = resolve(process.env.NEXT_RUNTIME_REFERENCE ?? '')
assert(process.env.NEXT_RUNTIME_REFERENCE && (reference.startsWith('/private/tmp/') || reference.startsWith(resolve(tmpdir()) + '/')) && existsSync(join(reference, 'node_modules/next')), 'A disposable installed frozen Next reference is required.')
const configPath = process.env.TEST_SUPABASE_CONFIG
assert(configPath, 'Supply an isolated local test-service configuration.')
const config = z.object({ url: z.string().url(), anonKey: z.string().min(1), serviceKey: z.string().min(1) }).parse(JSON.parse(readFileSync(configPath, 'utf8')))
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.url).hostname), 'Remote services are forbidden in this disposable acceptance runner.')
const baseEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: '1' }
const verificationEnv = { ...baseEnv, SUPREMO_VALIDATION: '1', SUPABASE_URL: config.url, SUPABASE_ANON_KEY: config.anonKey, SUPABASE_SERVICE_ROLE_KEY: config.serviceKey, NEXT_PUBLIC_SUPABASE_URL: config.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: config.anonKey, VITE_SUPABASE_URL: config.url, VITE_SUPABASE_ANON_KEY: config.anonKey }
const report: Record<string, unknown> = { workspace, node: process.version, startedAt: new Date().toISOString(), definition: 'Wall-clock npm run verify:full -- --background on original generated gate ordering. Actual typecheck, lint, coverage, RLS, strict audit, changed-source browser smoke and production build; no migration reset or remote CI scheduling.' }
const redact = (text: string) => text.replaceAll(config.serviceKey, '[local-test-service-key]').replaceAll(config.anonKey, '[local-test-anon-key]')
function run(cwd: string, command: string, args: string[], env = baseEnv) {
  return execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: 'pipe', timeout: 300_000, maxBuffer: 20_000_000 })
}
async function freePort() {
  const server = createServer()
  await new Promise<void>((ok, no) => server.listen(0, '127.0.0.1', ok).once('error', no))
  const address = server.address(); assert(address && typeof address !== 'string')
  await new Promise<void>((ok, no) => server.close(error => error ? no(error) : ok()))
  return address.port
}
async function measure(cwd: string, stack: string, sourcePath: string) {
  // Only the disposable fixture gets local git history, required by the real
  // verifier. A whitespace source edit selects its existing browser gate.
  assert(!existsSync(join(cwd, '.git')), 'Refusing to rewrite an existing fixture git history.')
  run(cwd, 'git', ['init', '-q'])
  run(cwd, 'git', ['add', '.'])
  run(cwd, 'git', ['-c', 'user.name=Runtime acceptance', '-c', 'user.email=runtime@example.invalid', 'commit', '-qm', 'Generated verification baseline'])
  const original = readFileSync(join(cwd, sourcePath), 'utf8')
  writeFileSync(join(cwd, sourcePath), original + '\n')
  const started = performance.now()
  let exitCode = 0, output = ''
  try { output = run(cwd, 'npm', ['run', 'verify:full', '--', '--background'], { ...verificationEnv, PLAYWRIGHT_PORT: String(await freePort()) }) }
  catch (error) {
    const failure = error as Error & { status?: number; stdout?: string; stderr?: string }
    exitCode = failure.status ?? 1
    output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}\n${failure.message}`
  } finally { writeFileSync(join(cwd, sourcePath), original) }
  const elapsedMs = Math.round(performance.now() - started)
  writeFileSync(join(workspace, `${stack}-verify.log`), redact(output))
  const receiptPath = join(cwd, '.supremo/verify-result.json')
  const receipt: unknown = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : null
  const result = { cwd, elapsedMs, exitCode, receipt }
  if (exitCode !== 0) process.exitCode = 1
  report[stack] = result
  console.log(JSON.stringify({ stack, elapsedMs, exitCode, receipt }))
  writeFileSync(join(workspace, 'evidence.json'), JSON.stringify(report, null, 2))
}
try {
  const next = join(workspace, 'next-team')
  cpSync(reference, next, { recursive: true, filter: source => {
    const parts = relative(reference, source).split(sep)
    if (parts.some(part => ['.git', 'node_modules', '.next', 'coverage', 'playwright-report', 'test-results'].includes(part))) return false
    // The measured baseline is source, not disposable preview output produced
    // by an earlier benchmark. Keep managed project metadata unchanged.
    if (parts[0] === '.supremo' && parts.length > 1 && /^(?:preview[.-]|verify-result\.json)/.test(parts[1] ?? '')) return false
    return !parts.at(-1)?.endsWith('.tsbuildinfo')
  } })
  writeFileSync(join(workspace, 'next-install.log'), run(next, 'npm', ['ci', '--no-audit', '--no-fund']))
  const start = join(workspace, 'start-team')
  for (const file of buildProjectFiles({ stack: 'tanstack-start-vite', kind: 'team', projectName: 'supremo-stack-proof', description: 'Comparable generated app baseline' })) {
    const target = join(start, file.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, file.content)
  }
  writeFileSync(join(workspace, 'install.log'), run(start, 'npm', ['ci', '--no-audit', '--no-fund']))
  await measure(next, 'next', 'app/page.tsx')
  await measure(start, 'start', 'src/routes/index.tsx')
} catch (error) { report.error = redact(String(error)); process.exitCode = 1 }
finally { writeFileSync(join(workspace, 'evidence.json'), JSON.stringify(report, null, 2)); console.log(`Evidence: ${join(workspace, 'evidence.json')}`) }
