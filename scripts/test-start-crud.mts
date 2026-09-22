/** Real browser CRUD acceptance against explicitly supplied, disposable local Supabase services.
 * No database/Auth mocks. Requires loopback native Auth/PostgREST and an isolated PostgreSQL DB.
 * SUPREMO_ACCEPTANCE_CONFIG=/private/tmp/.../test-config.json node --import tsx scripts/test-start-crud.mts
 * The JSON config needs url, anonKey, serviceKey (synthetic-account cleanup only), and databaseUrl. Credentials are never included in evidence.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { buildProjectFiles } from '../src/lib/templates/project-files'

const configPath = process.env.SUPREMO_ACCEPTANCE_CONFIG
assert(configPath, 'Provide an explicit isolated local Supabase config; no environment credentials are inferred.')
const config = JSON.parse(readFileSync(configPath, 'utf8')) as { url: string; anonKey: string; serviceKey: string; databaseUrl: string }
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.url).hostname), 'Only loopback Supabase endpoints are accepted.')
const database = new URL(config.databaseUrl)
assert(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) && database.pathname.includes('acceptance'), 'Only an explicitly named local acceptance database is accepted.')
const workspace = mkdtempSync(join(tmpdir(), 'supremo-start-crud-'))
const app = join(workspace, 'app')
const base = 'http://127.0.0.1:55500'
const fixtures = new URL('./fixtures/start-crud/', import.meta.url).pathname
const runId = randomUUID().slice(0, 8)
const psql = process.env.PSQL_BIN ?? 'psql'
const createdUserIds = new Set<string>()
const accounts = ['a', 'b'].map(label => ({ label, email: `crud-${runId}-${label}@supremo-test.example`, password: `Synthetic-${randomUUID()}-1a!` }))
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), workspace, syntheticOnly: true, realAuthAndDatabase: true, checks: {}, timingsMs: {} }
const checks = report.checks as Record<string, unknown>
const timings = report.timingsMs as Record<string, number>
const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, VITE_SUPABASE_URL: config.url, VITE_SUPABASE_ANON_KEY: config.anonKey, CI: '1' }
let browser: Browser | undefined
let server: ChildProcess | undefined
function save() { writeFileSync(join(workspace, 'evidence.json'), JSON.stringify(report, null, 2)) }
function write(path: string, content: string) { mkdirSync(dirname(join(app, path)), { recursive: true }); writeFileSync(join(app, path), content) }
function command(binary: string, args: string[], label: string, input?: string) {
  const start = performance.now()
  try {
    const output = execFileSync(binary, args, { cwd: app, env: environment, encoding: 'utf8', timeout: 240_000, maxBuffer: 20_000_000, input, stdio: 'pipe' })
    writeFileSync(join(workspace, `${label}.log`), output)
    timings[label] = Math.round(performance.now() - start)
    console.log(`${label}: passed (${timings[label]}ms)`)
    return output
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    writeFileSync(join(workspace, `${label}-failed.log`), `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`)
    throw new Error(`${label} failed; see isolated workspace log`, { cause: error })
  }
}
function walk(path: string): string[] { return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]) }
async function waitForServer() {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { if ((await fetch(base, { signal: AbortSignal.timeout(1000) })).ok) return } catch { /* An owned test process is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Owned acceptance server did not become healthy')
}
async function signup(page: Page, account: typeof accounts[number]) {
  await page.goto(`${base}/login`)
  await page.getByRole('button', { name: 'Criar uma conta', exact: true }).click()
  await page.getByLabel('Email', { exact: true }).fill(account.email)
  await page.getByLabel('Senha', { exact: true }).fill(account.password)
  const signupReply = page.waitForResponse(response => response.url().includes('/auth/v1/signup'), { timeout: 20_000 })
  await page.getByRole('button', { name: 'Criar conta', exact: true }).click()
  const response = await signupReply
  const payload = await response.json() as { user?: { id?: string }; id?: string }
  assert(response.ok(), `Synthetic signup failed with HTTP ${response.status()}`)
  const userId = payload.user?.id ?? payload.id
  assert(userId, 'Real Auth signup response must include the created identity')
  createdUserIds.add(userId)
  try { await page.waitForURL(`${base}/app`, { timeout: 20_000 }) }
  catch { throw new Error(`Browser signup did not reach /app: ${(await page.getByRole('status').allTextContents()).join(' | ')}`) }
  await page.goto(`${base}/notes/`)
  await page.getByRole('heading', { name: 'Minhas notas' }).waitFor()
}
async function captureMutation(page: Page, action: () => Promise<unknown>) {
  const capture = page.waitForRequest(request => request.url().includes('/_serverFn/') && request.method() === 'POST')
  await action()
  return capture
}
async function replay(context: BrowserContext, request: Request, replacement?: string, url = request.url()) {
  const headers = { ...request.headers(), origin: base }
  for (const key of ['host', 'cookie', 'content-length', 'connection']) delete headers[key]
  // Chromium accepts Secure cookies on trustworthy loopback HTTP. The standalone
  // API client may omit them: explicitly replay only this context's own cookies.
  const cookies = await context.cookies()
  if (cookies.length) headers.cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  const response = await context.request.fetch(url, { method: request.method(), headers, data: replacement ?? request.postData() ?? undefined })
  const text = await response.text()
  return { status: response.status(), body: text }
}

try {
  for (const file of buildProjectFiles({ stack: 'tanstack-start-vite', kind: 'solo', projectName: 'CRUD acceptance', description: 'Generated authentication and notes CRUD acceptance' })) write(file.path, file.content)
  for (const file of walk(fixtures)) write(relative(fixtures, file).replace(/\.txt$/, ''), readFileSync(file, 'utf8'))
  command('npm', ['ci', '--no-audit', '--no-fund'], 'install')
  command('npm', ['run', 'typecheck'], 'typecheck')
  command('npm', ['run', 'lint'], 'lint')
  command('npm', ['run', 'audit:security', '--', '--strict'], 'security-audit')
  command('npm', ['run', 'test:coverage'], 'coverage')
  command('npm', ['run', 'build'], 'production-build')
  // The isolated base schema is provisioned by the native acceptance harness. Apply just this feature once.
  const exists = command(psql, [config.databaseUrl, '-X', '-At', '-c', "SELECT to_regclass('public.notes') IS NOT NULL"], 'notes-schema-check').trim() === 't'
  if (!exists) command(psql, [config.databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1'], 'notes-migration', readFileSync(join(app, 'supabase/migrations/20260922000000_notes.sql'), 'utf8'))
  command(psql, [config.databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-c', "NOTIFY pgrst, 'reload schema'"], 'schema-reload')
  server = spawn(process.execPath, ['scripts/start-production.mjs', '--port', '55500'], { cwd: app, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  let serverLog = ''
  server.stdout?.on('data', data => { serverLog += String(data) })
  server.stderr?.on('data', data => { serverLog += String(data) })
  server.once('exit', () => writeFileSync(join(workspace, 'production-server.log'), serverLog))
  await waitForServer()
  browser = await chromium.launch({ headless: true })
  const contextA = await browser.newContext(), contextB = await browser.newContext(), anonymous = await browser.newContext()
  const pageA = await contextA.newPage(), pageB = await contextB.newPage()
  const browserErrors: string[] = []
  for (const page of [pageA, pageB]) page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text().replace(/eyJ[A-Za-z0-9_.-]+/g, '[redacted JWT]')) })
  report.browserErrors = browserErrors
  await signup(pageA, accounts[0])
  await signup(pageB, accounts[1])
  checks.browserSignupAndAuthenticatedSsr = { sessions: 2, passed: true }
  const titleA = `Acceptance alpha ${runId}`, titleB = `Acceptance beta ${runId}`
  await pageA.getByLabel('Título', { exact: true }).fill(titleA)
  const createRequest = await captureMutation(pageA, () => pageA.getByRole('button', { name: 'Criar nota', exact: true }).click())
  await pageA.getByRole('link', { name: titleA, exact: true }).waitFor()
  await pageA.getByLabel('Título', { exact: true }).fill(titleB)
  await pageA.getByRole('button', { name: 'Criar nota', exact: true }).click()
  await pageA.getByRole('link', { name: titleB, exact: true }).waitFor()
  await pageA.getByLabel('Filtro', { exact: true }).fill('alpha')
  await pageA.getByRole('button', { name: 'Filtrar', exact: true }).click()
  await pageA.waitForURL(/q=alpha/)
  await pageA.getByRole('link', { name: titleA, exact: true }).waitFor()
  await pageA.getByRole('link', { name: titleB, exact: true }).waitFor({ state: 'hidden' })
  assert.equal(await pageA.getByRole('link', { name: titleB, exact: true }).count(), 0)
  const listedId = (await pageA.getByRole('link', { name: titleA, exact: true }).getAttribute('href'))!.split('/').at(-1)!
  const readCapture = pageA.waitForRequest(request => request.url().includes('/_serverFn/') && request.method() === 'GET' && request.url().includes(listedId))
  await pageA.getByRole('link', { name: titleA, exact: true }).click()
  const readRequest = await readCapture
  await pageA.getByRole('heading', { name: titleA, exact: true }).waitFor()
  const detail = pageA.url()
  const noteId = new URL(detail).pathname.split('/').at(-1)!
  assert.match(noteId, /^[0-9a-f-]{36}$/)
  const edited = `Edited alpha ${runId}`
  await pageA.getByLabel('Título', { exact: true }).fill(edited)
  const updateRequest = await captureMutation(pageA, () => pageA.getByRole('button', { name: 'Salvar', exact: true }).click())
  await pageA.getByRole('heading', { name: edited, exact: true }).waitFor()
  checks.createFilterReadUpdate = { passed: true, filterExcludedOtherNote: true }
  const updatePayload = updateRequest.postData()!
  assert(updatePayload.includes(edited), 'Cross-user probe must change a captured real mutation payload')
  // Positive controls use the exact same replay transport and B's cookie jar.
  // A failing auth transport must not be mistaken for cross-user authorization.
  const ownTitleB = `Second owner note ${runId}`
  const createdByB = await replay(contextB, createRequest, createRequest.postData()!.replace(titleA, ownTitleB))
  assert(createdByB.body.includes(ownTitleB), 'B must create its own resource with replay transport')
  const ownIdB = createdByB.body.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0]
  assert(ownIdB, 'Real create response must identify B resource')
  const ownEditedB = `Second owner updated ${runId}`
  const ownUpdateB = await replay(contextB, updateRequest, updatePayload.replace(noteId, ownIdB).replace(edited, ownEditedB))
  assert(ownUpdateB.body.includes(ownEditedB), 'B must update its own resource over replay transport')
  const ownReadUrlB = readRequest.url().replace(noteId, ownIdB)
  const ownReadB = await replay(contextB, readRequest, undefined, ownReadUrlB)
  assert(ownReadB.body.includes(ownEditedB), 'B must read its own resource over replay transport')
  const deniedRead = await replay(contextB, readRequest)
  assert.notEqual(deniedRead.status, 401, 'Cross-user read requires the authenticated B session')
  assert.match(deniedRead.body, /Nota não encontrada/, 'Authenticated B cannot read A resource')
  const deniedUpdate = await replay(contextB, updateRequest, updatePayload.replace(edited, `Forbidden foreign edit ${runId}`))
  assert.notEqual(deniedUpdate.status, 401, 'The cross-user probe must be authenticated, not accidentally anonymous')
  assert.match(deniedUpdate.body, /Nota não encontrada/, 'Authenticated other user must be denied access to the resource')
  const deniedAnonymous = await replay(anonymous, updateRequest)
  assert.equal(deniedAnonymous.status, 401)
  const createPayload = createRequest.postData()!
  assert(createPayload.includes(titleA), 'Capture must contain the original title for an actual invalid-input probe')
  const malformed = await replay(contextA, createRequest, createPayload.replace(titleA, ''))
  assert(malformed.status >= 400 || /Zod|too_small|error/i.test(malformed.body), 'Malformed input must fail runtime validation')
  const crossOrigin = await contextA.request.fetch(updateRequest.url(), { method: 'POST', headers: { ...updateRequest.headers(), origin: 'https://attacker.invalid', 'sec-fetch-site': 'cross-site' }, data: updateRequest.postData()! })
  assert.equal(crossOrigin.status(), 403)
  await pageB.goto(detail)
  assert.equal(await pageB.getByRole('heading', { name: edited, exact: true }).count(), 0)
  assert(!(await pageB.content()).includes(edited), 'Other user SSR must not serialize private note')
  await pageA.reload()
  await pageA.getByRole('heading', { name: edited, exact: true }).waitFor()
  // Capture delete without allowing the owner's request through; replay it as the other actor first.
  let deleteRequest: Request | undefined
  await pageA.route('**/_serverFn/**', async route => {
    if (route.request().method() === 'POST') { deleteRequest = route.request(); await route.abort(); return }
    await route.continue()
  })
  await pageA.getByRole('button', { name: 'Excluir nota', exact: true }).click()
  await pageA.getByRole('status').filter({ hasText: 'Não foi possível excluir' }).waitFor()
  assert(deleteRequest)
  const deniedDelete = await replay(contextB, deleteRequest)
  assert.notEqual(deniedDelete.status, 401, 'The cross-user delete probe must use a real authenticated session')
  assert.match(deniedDelete.body, /Nota não encontrada/, 'Authenticated other user must not delete the resource')
  await pageA.unroute('**/_serverFn/**')
  await pageA.reload()
  await pageA.getByRole('heading', { name: edited, exact: true }).waitFor()
  const ownRereadB = await replay(contextB, readRequest, undefined, ownReadUrlB)
  assert(ownRereadB.body.includes(ownEditedB), 'B own record remains unchanged after all denials')
  checks.endpointDenials = { positiveBCreateUpdateRead: true, crossUserRead: deniedRead.status, crossUserUpdate: deniedUpdate.status, crossUserDelete: deniedDelete.status, crossUserAttemptedDifferentTitle: true, crossUserAuthenticatedResourceDenial: true, anonymousMutation: deniedAnonymous.status, crossOriginMutation: crossOrigin.status(), invalidInput: malformed.status, runtimeValidationError: /Zod|too_small|Too small/i.test(malformed.body), ownerRereadUnchanged: true }
  await pageA.getByRole('button', { name: 'Excluir nota', exact: true }).click()
  await pageA.waitForURL(/\/notes\/?(?:\?|$)/)
  await pageA.getByRole('heading', { name: 'Minhas notas' }).waitFor()
  assert.equal(await pageA.getByRole('link', { name: edited, exact: true }).count(), 0)
  await pageA.getByRole('link', { name: titleB, exact: true }).click()
  await pageA.getByRole('button', { name: 'Excluir nota', exact: true }).click()
  await pageA.waitForURL(/\/notes\/?(?:\?|$)/)
  const ownDeleteB = await replay(contextB, deleteRequest, deleteRequest.postData()!.replace(noteId, ownIdB))
  assert(/deleted/.test(ownDeleteB.body) && !/Nota não encontrada/.test(ownDeleteB.body), 'B deletes its own resource using the same transport')
  checks.deleteAndNavigation = { browserOwnerA: true, positiveBDelete: true }
  // Verify cleanup and final owner state through the same public SDK login used by the application.
  for (const account of accounts) {
    const client = createClient(config.url, config.anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const login = await client.auth.signInWithPassword({ email: account.email, password: account.password })
    assert(!login.error && login.data.user)
    const notes = await client.from('notes').select('id')
    assert(!notes.error)
    assert.equal(notes.data.length, 0)
    await client.auth.signOut()
  }
  checks.finalAuthenticatedReads = { sessions: 2, notesRemaining: 0 }
  report.passed = true
  save()
  console.log(JSON.stringify({ passed: true, evidence: join(workspace, 'evidence.json'), checks }))
} catch (error) {
  report.passed = false
  report.failure = error instanceof Error ? error.message : String(error)
  report.failureLocation = error instanceof Error ? error.stack?.split('\n').filter(line => line.includes('test-start-crud')).join('\n') : undefined
  save()
  console.error(JSON.stringify({ passed: false, evidence: join(workspace, 'evidence.json'), failure: report.failure }))
  process.exitCode = 1
} finally {
  await browser?.close()
  server?.kill('SIGTERM')
  if (createdUserIds.size) {
    const admin = createClient(config.url, config.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const cleanupErrors: string[] = []
    for (const id of createdUserIds) {
      const { error } = await admin.auth.admin.deleteUser(id)
      if (error) cleanupErrors.push('Synthetic account cleanup failed')
    }
    report.syntheticAccountCleanup = { requested: createdUserIds.size, failed: cleanupErrors.length }
    if (cleanupErrors.length) { report.passed = false; process.exitCode = 1 }
    save()
  }
}
