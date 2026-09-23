/** Real browser/runtime acceptance, entirely in an owned temporary generated app.
 * Run: node --import tsx scripts/test-start-runtime.mts
 * Optional NEXT_RUNTIME_REFERENCE points at an already validated disposable Next fixture.
 * No Supabase credentials or real data are needed; database isolation is tested separately.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { performance } from 'node:perf_hooks'
import { chromium, type Browser, type Page, type Request } from '@playwright/test'
import { buildProjectFiles } from '../src/lib/templates/project-files'

const workspace = mkdtempSync(join(tmpdir(), 'supremo-start-runtime-'))
const app = join(workspace, 'app')
const report: Record<string, unknown> = { workspace, node: process.version, platform: process.platform, startedAt: new Date().toISOString(), checks: {}, timings: {}, databaseIsolation: 'Not exercised by this runtime suite; no database emulation is counted as isolation.' }
const checks = report.checks as Record<string, unknown>
const timings = report.timings as Record<string, unknown>
const canaries = ['synthetic-service-role-DO-NOT-SHIP-97b52', 'synthetic-jwt-private-DO-NOT-SHIP-31fe7', 'synthetic-vite-private-DO-NOT-SHIP-854ae', 'synthetic-prefixed-service-role-DO-NOT-SHIP-e9147']
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
  VITE_SUPABASE_URL: 'http://127.0.0.1:9', VITE_SUPABASE_ANON_KEY: 'synthetic-public-anon',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-anon',
  SUPABASE_SERVICE_ROLE_KEY: canaries[0], SUPABASE_JWT_SECRET: canaries[1],
  VITE_PRIVATE_CANARY: canaries[2], VITE_SUPABASE_SERVICE_ROLE_KEY: canaries[3], CI: '1',
}
let browser: Browser | undefined
let production: ChildProcess | undefined
const ownedPreviews = new Set<string>()
let logSequence = 0

function record() { writeFileSync(join(workspace, 'evidence.json'), JSON.stringify(report, null, 2)) }
function command(cwd: string, binary: string, args: string[], label: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const started = performance.now()
  try {
    const output = execFileSync(binary, args, { cwd, env: { ...env, ...extraEnv }, timeout: 240_000, maxBuffer: 20_000_000, encoding: 'utf8', stdio: 'pipe' })
    writeFileSync(join(workspace, `${++logSequence}-${label}.log`), output)
    const elapsedMs = Math.round(performance.now() - started)
    console.log(`${label}: ${elapsedMs}ms`)
    return { output, elapsedMs }
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    writeFileSync(join(workspace, `${++logSequence}-${label}-failed.log`), `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`)
    throw error
  }
}
function samples(values: number[]) { return { milliseconds: values, medianMs: [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] } }
async function freePort() {
  const server = createServer()
  await new Promise<void>((ok, no) => server.listen(0, '127.0.0.1', ok).once('error', no))
  const address = server.address()
  assert(address && typeof address !== 'string')
  await new Promise<void>((ok, no) => server.close(error => error ? no(error) : ok()))
  return address.port
}
async function waitUntil(check: () => Promise<boolean>, timeout = 45_000) {
  const start = performance.now()
  while (performance.now() - start < timeout) {
    if (await check()) return
    await new Promise(ok => setTimeout(ok, 75))
  }
  throw new Error(`Condition did not become true in ${timeout}ms`)
}
async function healthy(url: string) { try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); return response.ok } catch { return false } }
function write(cwd: string, path: string, content: string) { mkdirSync(resolve(cwd, path, '..'), { recursive: true }); writeFileSync(join(cwd, path), content) }
function previewStatus(cwd: string) { return JSON.parse(command(cwd, process.execPath, ['scripts/preview.mjs', 'status'], 'preview-status').output) as { healthy: boolean; pid: number; port: number } }
function ensure(cwd: string, port: number) {
  ownedPreviews.add(cwd)
  return command(cwd, process.execPath, ['scripts/preview.mjs', 'ensure'], 'preview-ensure', { PORT: String(port) }).elapsedMs
}
function stopPreview(cwd: string) { command(cwd, process.execPath, ['scripts/preview.mjs', 'stop'], 'preview-stop'); ownedPreviews.delete(cwd) }
function scanPublic(cwd: string) {
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)])
  const files = walk(join(cwd, '.output/public'))
  for (const file of files) for (const secret of canaries) assert(!readFileSync(file).includes(Buffer.from(secret)), `Private canary exposed in ${file}`)
  return files.length
}
function rpcHeaders(request: Request, origin: string) {
  const headers = { ...request.headers(), origin }
  for (const key of ['host', 'content-length', 'cookie', 'connection']) delete headers[key]
  return headers
}

async function experienceAcceptance(page: Page, url: string) {
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  for (const width of [1440, 390]) for (const colorScheme of ['light', 'dark'] as const) {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { level: 1 }).waitFor()
    assert.equal(await page.locator('html').getAttribute('lang'), 'pt-BR')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Home must fit its viewport')
    assert((await page.evaluate(() => getComputedStyle(document.body).fontFamily)).includes('system-ui'), 'Start must resolve its font without a Next-only variable')
    await page.screenshot({ path: join(workspace, `home-${width}-${colorScheme}.png`), fullPage: true })
    await page.getByRole('link', { name: 'Criar minha conta', exact: true }).click()
    await page.getByRole('heading', { name: 'Crie sua conta', exact: true }).waitFor()
    assert.equal(new URL(page.url()).searchParams.get('mode'), 'signup')
    await page.getByLabel('Email', { exact: true }).fill('draft@example.invalid')
    await page.getByRole('button', { name: 'Já tenho uma conta', exact: true }).click()
    await page.getByRole('heading', { name: 'Entre na sua conta', exact: true }).waitFor()
    assert.equal(await page.getByLabel('Email', { exact: true }).inputValue(), 'draft@example.invalid', 'Changing access mode must preserve the draft')
    assert.equal(await page.getByLabel('Senha', { exact: true }).getAttribute('autocomplete'), 'current-password')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Auth must fit its viewport')
    await page.screenshot({ path: join(workspace, `login-${width}-${colorScheme}.png`), fullPage: true })
  }
  const response = await page.goto(`${url}/missing-experience-proof`)
  assert.equal(response?.status(), 404)
  await page.getByRole('link', { name: 'Voltar ao início', exact: true }).click()
  await page.getByRole('heading', { level: 1 }).waitFor()
  assert.equal(new URL(page.url()).pathname, '/')
  assert(!requests.some(request => /fonts\.googleapis\.com|fonts\.gstatic\.com|__supremo\/browser-diagnostics/.test(request)), 'Production presentation must not request remote fonts or a dev collector')
  checks.firstExperience = { desktopAndMobile: true, lightAndDark: true, localFont: true, signupLink: true, modePreservesDraft: true, notFoundRecovery: true }
}

async function componentAcceptance(page: Page, url: string) {
  await page.goto(`${url}/runtime-components`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Abrir diálogo', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Exemplo acessível' })
  await dialog.waitFor()
  await page.getByLabel('Nome de exemplo').fill('Preservado')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('button', { name: 'Abrir diálogo', exact: true }).evaluate(element => element === document.activeElement), true)
  await page.getByRole('button', { name: 'Ações', exact: true }).focus()
  await page.keyboard.press('ArrowDown')
  await page.getByRole('menuitem', { name: 'Escolher' }).waitFor()
  await page.keyboard.press('Enter')
  await page.getByRole('status').filter({ hasText: 'Selecionado' }).waitFor()
  await page.getByRole('tab', { name: 'Primeira' }).focus()
  await page.keyboard.press('ArrowRight')
  await page.getByRole('tabpanel', { name: 'Segunda' }).waitFor()
  await page.getByRole('button', { name: 'Ajuda', exact: true }).focus()
  await page.getByRole('tooltip').waitFor()
  await page.screenshot({ path: join(workspace, 'components-mobile-dark.png'), fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  checks.accessibleComponents = { dialogFocusRestored: true, dropdownKeyboard: true, tabsKeyboard: true, tooltipFocus: true, productionCsp: true }
}

async function devAcceptance(cwd: string, stack: 'start' | 'next') {
  const uiPath = stack === 'start' ? 'src/features/example/greeting-form.tsx' : 'app/runtime-form.tsx'
  const originalUi = readFileSync(join(cwd, uiPath), 'utf8')
  const uiFixture = originalUi.replace(stack === 'start' ? '<Label htmlFor="name">' : '<label htmlFor="name">', stack === 'start' ? '<h2>Runtime proof</h2><Label htmlFor="name">' : '<h2>Runtime proof</h2><label htmlFor="name">')
  assert.notEqual(uiFixture, originalUi)
  write(cwd, uiPath, uiFixture)
  const port = await freePort()
  const startup: number[] = [], reuse: number[] = []
  let status: ReturnType<typeof previewStatus> | undefined
  for (let round = 0; round < 3; round++) {
    startup.push(ensure(cwd, port))
    status = previewStatus(cwd)
    assert(status.healthy)
    reuse.push(ensure(cwd, port))
    assert.equal(previewStatus(cwd).pid, status.pid, 'Healthy preview must keep its PID')
    if (round < 2) stopPreview(cwd)
  }
  assert(status)
  const pid = status.pid
  // Preserve each framework's existing dev origin policy: the frozen Next
  // fixture advertises localhost and deliberately rejects 127.0.0.1 assets.
  const url = `http://${stack === 'next' ? 'localhost' : '127.0.0.1'}:${status.port}`
  const formUrl = stack === 'start' ? `${url}/examples` : url
  const page = await browser!.newPage()
  const hydrationStarted = performance.now()
  await page.goto(formUrl, { waitUntil: 'networkidle' })
  // Inputs exist in SSR HTML before the development client has hydrated. Prove
  // the RPC interaction first so draft preservation measures Fast Refresh,
  // not the initial hydration replacing an edited pre-hydration DOM node.
  await page.getByLabel('Seu nome').fill('Ready')
  await page.getByRole('button', { name: 'Enviar saudação' }).click()
  await page.getByRole('status').filter({ hasText: 'Olá, Ready!' }).waitFor()
  const initialBrowserReadyMs = Math.round(performance.now() - hydrationStarted)
  await page.getByLabel('Seu nome').fill('Persistente')
  const ui: number[] = [], route: number[] = [], server: number[] = []
  let routeNavigationInterruptions = 0
  const navigateDuringRouteUpdate = async (target: string) => {
    try { return await page.goto(target) }
    catch (error) {
      // Creating/deleting route files deliberately invalidates the route tree;
      // its automatic document reload may cancel an in-flight navigation.
      if (error instanceof Error && /ERR_ABORTED|interrupted by another navigation/.test(error.message)) { routeNavigationInterruptions++; return null }
      throw error
    }
  }
  timings[`${stack}RuntimeSamples`] = { startup, reuse, ui, route, server }
  for (let round = 0; round < 3; round++) {
    const text = `Runtime marker ${round}`
    const started = performance.now()
    write(cwd, uiPath, uiFixture.replace('Runtime proof', text))
    await page.getByRole('heading', { name: text, exact: true }).waitFor()
    ui.push(Math.round(performance.now() - started))
    assert.equal(await page.getByLabel('Seu nome').inputValue(), 'Persistente', 'HMR must preserve live form state')
  }
  for (let round = 0; round < 3; round++) {
    const routePath = stack === 'start' ? 'src/routes/runtime-new.tsx' : 'app/runtime-new/page.tsx'
    const content = stack === 'start' ? `import { createFileRoute } from '@tanstack/react-router'\nexport const Route=createFileRoute('/runtime-new')({component:()=> <h1>Route round ${round}</h1>})\n` : `export default function Page(){return <h1>Route round ${round}</h1>}\n`
    const started = performance.now()
    write(cwd, routePath, content)
    await waitUntil(async () => { if (!await navigateDuringRouteUpdate(`${url}/runtime-new`)) return false; return await page.getByRole('heading', { name: `Route round ${round}` }).count() === 1 })
    route.push(Math.round(performance.now() - started))
    rmSync(join(cwd, routePath))
    await waitUntil(async () => { const response = await navigateDuringRouteUpdate(`${url}/runtime-new`); return response?.status() === 404 })
  }
  await page.goto(formUrl, { waitUntil: 'networkidle' })
  await page.getByLabel('Seu nome').fill('Servidor')
  const serverPath = stack === 'start' ? 'src/features/example/example.functions.ts' : 'app/runtime-action.ts'
  const serverOriginal = readFileSync(join(cwd, serverPath), 'utf8')
  for (let round = 0; round < 3; round++) {
    const suffix = ` round-${round}`
    const replacement = stack === 'start' ? serverOriginal.replace('greeting(data.name)', `greeting(data.name) + '${suffix}'`) : serverOriginal.replace('`Olá, ${name}!`', '`Olá, ${name}! round-' + round + '`')
    assert.notEqual(replacement, serverOriginal)
    const started = performance.now()
    write(cwd, serverPath, replacement)
    await waitUntil(async () => {
      await page.getByLabel('Seu nome').fill('Servidor')
      await page.getByRole('button', { name: 'Enviar saudação' }).click()
      return (await page.getByRole('status').textContent())?.includes(suffix) ?? false
    })
    server.push(Math.round(performance.now() - started))
  }
  assert.equal(previewStatus(cwd).pid, pid, 'Edits must not restart the preview process')
  if (stack === 'start') {
    const routePath = 'src/routes/index.tsx'
    const originalRoute = readFileSync(join(cwd, routePath), 'utf8')
    try {
      write(cwd, routePath, `import './supremo-deliberate-missing-import'\n${originalRoute}`)
      await waitUntil(async () => (await fetch(url)).status === 500)
      ensure(cwd, port)
      assert.equal(previewStatus(cwd).pid, pid, 'A temporary compilation error must not restart Vite')
    } finally { write(cwd, routePath, originalRoute) }
    await waitUntil(async () => (await fetch(url)).status === 200)
    assert.equal(previewStatus(cwd).pid, pid, 'Fixing the temporary error must recover the same Vite process')
  }
  await page.close()
  const reconnect = await browser!.newPage()
  await reconnect.goto(formUrl)
  await reconnect.getByRole('heading', { name: 'Runtime marker 2', exact: true }).waitFor()
  if (stack === 'start') {
    const diagnosticFile = join(cwd, '.supremo/runtime/browser-diagnostics.json')
    // The heading exists in SSR HTML before the client module/observer loads.
    // A real RPC proves this reconnected page has hydrated before the event.
    await reconnect.waitForLoadState('networkidle')
    await reconnect.getByLabel('Seu nome').fill('DiagnosticReady')
    await reconnect.getByRole('button', { name: 'Enviar saudação' }).click()
    await reconnect.getByRole('status').filter({ hasText: 'Olá, DiagnosticReady!' }).waitFor()
    await reconnect.evaluate(() => window.dispatchEvent(new ErrorEvent('error', {
      error: new TypeError('synthetic-private-message-DO-NOT-PERSIST'),
      filename: location.origin + '/src/router.tsx?secret=DO-NOT-PERSIST', lineno: 1, colno: 1,
    })))
    await waitUntil(async () => existsSync(diagnosticFile) && JSON.parse(readFileSync(diagnosticFile, 'utf8')).events.length > 0)
    const diagnostic = readFileSync(diagnosticFile, 'utf8')
    assert(!diagnostic.includes('DO-NOT-PERSIST'))
    const event = JSON.parse(diagnostic).events.find((entry: { name: string }) => entry.name === 'TypeError')
    assert.equal(event?.file, 'src/router.tsx')
    assert.equal(event?.generatedLine, 1)
    checks.localBrowserDiagnostics = { realHydratedBrowser: true, advisoryOnly: true, messageAndQueryOmitted: true }
  }
  await reconnect.close()
  write(cwd, uiPath, originalUi)
  write(cwd, serverPath, serverOriginal)
  stopPreview(cwd)
  return { startup: samples(startup), healthyReuse: samples(reuse), initialBrowserReadyMs, uiHmr: samples(ui), routeAdd: samples(route), serverEdit: samples(server), componentDraftPreserved: true, editedComponent: uiPath, pidPreserved: true, browserReconnect: true, routeDeletion: true, routeNavigationInterruptions, ...(stack === 'start' ? { compileErrorPidPreservedAndRecovered: true } : {}), note: 'Round 1 startup starts with generated/install/build caches. Rounds 2–3 reuse framework caches. Initial browser readiness includes network-idle and an actual RPC before editing. Polling adds up to 75ms to route and server results.' }
}

try {
  const files = buildProjectFiles({ stack: 'tanstack-start-vite', kind: 'solo', projectName: 'Runtime proof', description: 'Disposable browser acceptance fixture' })
  for (const file of files) write(app, file.path, file.content)
  // Synthetic local identity enables diagnostics without a device, credentials or remote calls.
  write(app, '.supremo/project.json', JSON.stringify({ projectId: '9577816d-886a-466f-8bf2-0fcce3bd9272' }))
  timings.install = command(app, 'npm', ['ci', '--no-audit', '--no-fund'], 'npm-ci').elapsedMs
  timings.routes = command(app, 'npm', ['run', 'routes:generate'], 'route-generation').elapsedMs
  timings.typecheck = command(app, 'npm', ['run', 'typecheck'], 'typecheck').elapsedMs
  checks.originalGeneratedTypecheck = true
  // A fixture-only public button invokes the real protected profile RPC without a session.
  write(app, 'src/routes/runtime-private.tsx', `import {createFileRoute} from '@tanstack/react-router'\nimport {useServerFn} from '@tanstack/react-start'\nimport {useState} from 'react'\nimport {updateProfile} from '@/features/profile/profile.functions'\nexport const Route=createFileRoute('/runtime-private')({component:Probe})\nfunction Probe(){const call=useServerFn(updateProfile);const[state,setState]=useState('idle');return <><button onClick={async()=>{try{await call({data:{displayName:'Runtime proof'}});setState('ALLOWED')}catch{setState('DENIED')}}}>Protected RPC</button><p role="status">{state}</p></>}\n`)
  write(app, 'src/routes/runtime-components.tsx', `import {createFileRoute} from '@tanstack/react-router'
import {useState} from 'react'
import {Button} from '@/components/ui/button'
import {Dialog,DialogTrigger,DialogContent,DialogTitle,DialogDescription} from '@/components/ui/dialog'
import {DropdownMenu,DropdownMenuTrigger,DropdownMenuContent,DropdownMenuItem} from '@/components/ui/dropdown-menu'
import {Tabs,TabsList,TabsTrigger,TabsContent} from '@/components/ui/tabs'
import {TooltipProvider,Tooltip,TooltipTrigger,TooltipContent} from '@/components/ui/tooltip'
export const Route=createFileRoute('/runtime-components')({component:Probe})
function Probe(){const[selected,setSelected]=useState(false);return <main className="space-y-6 p-8">
<Dialog><DialogTrigger asChild><Button>Abrir diálogo</Button></DialogTrigger><DialogContent><DialogTitle>Exemplo acessível</DialogTitle><DialogDescription>Interação de teste.</DialogDescription><label>Nome de exemplo<input/></label></DialogContent></Dialog>
<DropdownMenu><DropdownMenuTrigger asChild><Button>Ações</Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem onSelect={()=>setSelected(true)}>Escolher</DropdownMenuItem></DropdownMenuContent></DropdownMenu><p role="status">{selected?'Selecionado':'Aguardando'}</p>
<Tabs defaultValue="one"><TabsList><TabsTrigger value="one">Primeira</TabsTrigger><TabsTrigger value="two">Segunda</TabsTrigger></TabsList><TabsContent value="one">Conteúdo um</TabsContent><TabsContent value="two">Conteúdo dois</TabsContent></Tabs>
<TooltipProvider delayDuration={0}><Tooltip><TooltipTrigger asChild><Button>Ajuda</Button></TooltipTrigger><TooltipContent>Ajuda por foco</TooltipContent></Tooltip></TooltipProvider>
</main>}
`)
  timings.productionBuild = command(app, 'npm', ['run', 'build'], 'production-build').elapsedMs
  const port = await freePort(), url = `http://127.0.0.1:${port}`
  const startup = performance.now()
  production = spawn(process.execPath, ['scripts/start-production.mjs', '--port', String(port)], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let productionOutput = ''
  production.stdout?.on('data', chunk => { productionOutput += chunk.toString() })
  production.stderr?.on('data', chunk => { productionOutput += chunk.toString() })
  await waitUntil(async () => { assert.equal(production!.exitCode, null, productionOutput); return healthy(url) })
  timings.productionStart = Math.round(performance.now() - startup)
  const ssr = await fetch(url), html = await ssr.text()
  assert(html.includes('Runtime proof') && html.includes('Criar minha conta'))
  assert((await (await fetch(`${url}/examples`)).text()).includes('Enviar saudação'))
  for (const canary of canaries) assert(!html.includes(canary))
  const csp = ssr.headers.get('content-security-policy')
  assert(csp?.includes('nonce-'))
  checks.ssr = { status: ssr.status, contentPresentBeforeHydration: true, nonceCsp: true }
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const browserErrors: string[] = []
  page.on('pageerror', error => browserErrors.push(error.message))
  const securityErrors: string[] = []
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to execute|hydration/i.test(message.text())) securityErrors.push(message.text()) })
  await experienceAcceptance(page, url)
  await componentAcceptance(page, url)
  await page.goto(`${url}/examples`)
  await page.getByLabel('Seu nome').fill('Supremo')
  const sent = page.waitForRequest(request => request.method() === 'POST' && request.url().includes('_serverFn'))
  await page.getByRole('button', { name: 'Enviar saudação' }).click()
  const request = await sent
  await page.getByRole('status').filter({ hasText: 'Olá, Supremo!' }).waitFor()
  assert.deepEqual(browserErrors, [])
  assert.deepEqual(securityErrors, [])
  checks.hydrationAndRpc = true
  const forbidden = await fetch(request.url(), { method: 'POST', headers: { ...rpcHeaders(request, 'https://untrusted.invalid'), 'sec-fetch-site': 'cross-site' }, body: request.postData() })
  assert.equal(forbidden.status, 403, 'Cross-origin mutation must fail CSRF')
  checks.csrfCrossOrigin = { status: forbidden.status }
  const body = request.postData()
  assert(body?.includes('Supremo'))
  const invalid = await fetch(request.url(), { method: 'POST', headers: rpcHeaders(request, url), body: body.replace('Supremo', '') })
  const invalidBody = await invalid.text()
  writeFileSync(join(workspace, 'invalid-rpc-response.json'), invalidBody)
  assert(invalid.status >= 400 || (invalidBody.includes('$TSR/Error') && invalidBody.includes('too_small') && invalidBody.includes('name')), `Invalid server input accepted: ${invalid.status}`)
  assert(!invalidBody.includes('Olá,'))
  checks.serverValidation = { status: invalid.status, rejected: true }
  await page.goto(`${url}/runtime-private`)
  const privateResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('_serverFn'))
  await page.getByRole('button', { name: 'Protected RPC' }).click()
  const protectedResult = await privateResponse
  assert.equal(protectedResult.status(), 401)
  await page.getByRole('status').filter({ hasText: 'DENIED' }).waitFor()
  checks.unauthenticatedPrivateRpc = { status: protectedResult.status() }
  checks.clientSecretScan = { scannedFiles: scanPublic(app), canaries: canaries.length, exposed: 0 }
  await page.close()
  production.kill('SIGTERM')
  await new Promise<void>(ok => production!.once('exit', () => ok()))
  production = undefined
  writeFileSync(join(workspace, 'production-server.log'), productionOutput)
  // This must fail at the compiler boundary, not only at a runtime authorization check.
  write(app, 'src/routes/runtime-leak.tsx', `import {createFileRoute} from '@tanstack/react-router'\nimport {requireUser} from '@/features/auth/auth.server'\nexport const Route=createFileRoute('/runtime-leak')({component:()=> <button onClick={()=>requireUser()}>Leak</button>})\n`)
  let rejected = false
  try { command(app, 'npm', ['run', 'build'], 'server-only-negative-build') } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    rejected = /import.protection|server.only|cannot.*client|denied/i.test(`${failure.stdout}\n${failure.stderr}`)
  }
  assert(rejected, 'Client import of server-only module must be rejected by the real production build')
  checks.serverOnlyBuildBoundary = true
  rmSync(join(app, 'src/routes/runtime-leak.tsx'))
  timings.startDevelopment = await devAcceptance(app, 'start')
  checks.development = true
  const reference = process.env.NEXT_RUNTIME_REFERENCE
  if (reference) {
    const next = resolve(reference)
    assert((next.startsWith('/private/tmp/') || next.startsWith(resolve(tmpdir()) + '/')) && existsSync(join(next, 'node_modules/next')), 'Reference must be a disposable installed Next fixture')
    const originals = ['app/page.tsx', 'app/runtime-form.tsx', 'app/runtime-action.ts'].map(path => ({ path, content: existsSync(join(next, path)) ? readFileSync(join(next, path), 'utf8') : null }))
    try {
      write(next, 'app/page.tsx', `import{RuntimeForm}from'./runtime-form'\nexport default function Page(){return <main><h1>Runtime proof</h1><RuntimeForm/></main>}\n`)
      write(next, 'app/runtime-form.tsx', `'use client'\nimport{useState}from'react'\nimport{greet}from'./runtime-action'\nexport function RuntimeForm(){const[message,setMessage]=useState('');return <form onSubmit={async event=>{event.preventDefault();setMessage(await greet(String(new FormData(event.currentTarget).get('name'))))}}><label htmlFor="name">Seu nome</label><input id="name" name="name"/><button>Enviar saudação</button><p role="status">{message}</p></form>}\n`)
      write(next, 'app/runtime-action.ts', "'use server'\nimport{z}from'zod'\nexport async function greet(input:string){const name=z.string().min(1).max(80).parse(input);return `Olá, ${name}!`}\n")
      timings.nextDevelopment = await devAcceptance(next, 'next')
    } finally { for (const original of originals) if (original.content === null) rmSync(join(next, original.path), { force: true }); else write(next, original.path, original.content) }
  }
  report.result = 'passed'
} catch (error) {
  report.result = 'failed'
  report.error = error instanceof Error ? error.stack : String(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  if (production?.exitCode === null) production.kill('SIGTERM')
  for (const cwd of ownedPreviews) { try { stopPreview(cwd) } catch (error) { checks.cleanupError = String(error) } }
  record()
  console.log(`Evidence: ${join(workspace, 'evidence.json')}`)
  console.log(JSON.stringify(report, null, 2))
}
