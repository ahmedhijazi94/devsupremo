import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  authorizeDevice, daemonCliOutputLooksValid, gitHooksVerified, linkSupabaseRemote,
  previewStatusHealthy, previewStatusUrl, validateLocalReadiness, type BootstrapConfig, type LocalReadiness,
} from './bootstrap'
import { deviceIssuer, LegacyDeviceIdentityError, readDeviceSecret, saveDeviceIdentity } from './device-identity'
import { readProjectStack } from './framework-runtime'
import { inspectHostAdapters } from './host-adapters'
import { resolveKeychain } from './keychain'
import { checkoutProject, configureAuthorizedCheckout, confirmPreparationDatabase, optionalSetupFile, PreparationDeviceUnauthorizedError, readSetupDatabase, recordPreparationConsent,
  setupConfigurationComplete, verifyCheckoutRepository, writeSetupFile } from './prepare-config'
import { ensureProjectRuntime, type ProjectRuntime } from './project-runtime'
import { validationWorkerHealthy } from './turn-validation'

export interface PrepareResult extends LocalReadiness {
  projectId: string
  authorization: 'reused' | 'authorized'
  dependencies: 'pending' | 'reused' | 'installed'
  runtimeVersion: string | null
  databaseStatus: 'pending' | 'confirmed'
  previewUrl: string | null
}

function output(cwd: string, runtime: ProjectRuntime, args: string[]): string | null {
  try {
    return execFileSync(runtime.node, args, { cwd, env: runtime.env, encoding: 'utf8',
      timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch { return null }
}

function npm(cwd: string, runtime: ProjectRuntime, args: string[]): void {
  execFileSync(runtime.node, [runtime.npm, ...args], { cwd, env: runtime.env, stdio: 'inherit' })
}

/** Resume only local infrastructure, without cloning, resetting code, testing
 * the application or creating a checkpoint. The trusted URL is never inferred. */
export async function runPrepare(opts: {
  url: string
  cwd?: string
  host?: 'claude-code' | 'codex'
}): Promise<PrepareResult> {
  const cwd = path.resolve(opts.cwd ?? process.cwd())
  const issuer = deviceIssuer(opts.url)
  const projectId = checkoutProject(cwd, issuer)
  verifyCheckoutRepository(cwd)
  const stack = readProjectStack(cwd)
  const keychain = resolveKeychain()
  let saved: string | null
  try { saved = readDeviceSecret(keychain, projectId, issuer) }
  catch (error) {
    if (!(error instanceof LegacyDeviceIdentityError)) throw error
    // The unbound legacy value is never returned or sent. Only a new official
    // browser flow at the explicit trusted issuer may replace it.
    saved = null
  }
  const complete = setupConfigurationComplete(cwd, stack)
  let authorized: BootstrapConfig | null = null
  let hasIdentity = saved !== null
  const authorizePreparation = async (requireNewIdentity: boolean): Promise<BootstrapConfig> => {
    const config = await authorizeDevice(projectId, issuer)
    if (config.project.id !== projectId) throw new Error('Projeto autorizado diverge do checkout.')
    // Save first: a repo/configuration or installation failure must not lose a
    // browser-approved credential or force the owner to repeat authorization.
    if (config.daemon) {
      saveDeviceIdentity(keychain, projectId, issuer, config.daemon.deviceSecret)
      hasIdentity = true
    } else if (requireNewIdentity) {
      throw new Error('A autorização não retornou identidade persistente; preparação interrompida.')
    }
    verifyCheckoutRepository(cwd, config.repo)
    if (config.project.stack !== undefined && config.project.stack !== stack) {
      throw new Error('A stack do checkout diverge do projeto autorizado; preparação interrompida.')
    }
    configureAuthorizedCheckout(cwd, stack, config)
    return config
  }
  if (!hasIdentity || !complete) authorized = await authorizePreparation(!hasIdentity)
  if (!hasIdentity) throw new Error('A autorização não retornou identidade persistente; preparação interrompida.')
  recordPreparationConsent(cwd, projectId, issuer)

  const result: PrepareResult = {
    ok: false, state: 'not_ready', integrationMode: 'unsupported', issues: [], projectId,
    authorization: authorized ? 'authorized' : 'reused', dependencies: 'pending', runtimeVersion: null, previewUrl: null, databaseStatus: 'pending',
  }
  const finish = (): PrepareResult => {
    writeSetupFile(cwd, '.supremo/prepare-readiness.json', JSON.stringify({ ...result, checkedAt: new Date().toISOString() }, null, 2) + '\n')
    return result
  }
  const database = readSetupDatabase(cwd)
  let secret = readDeviceSecret(keychain, projectId, issuer)
  if (!database || !secret) throw new Error('A configuração ou a identidade persistente ficou indisponível.')
  let confirmedDatabase: Awaited<ReturnType<typeof confirmPreparationDatabase>>
  const databaseUnavailable = (): PrepareResult => {
    result.issues.push('Não foi possível confirmar no Supremo o mesmo banco development. A configuração local foi preservada; confira o vínculo antes de retomar prepare.')
    return finish()
  }
  try {
    confirmedDatabase = await confirmPreparationDatabase(projectId, issuer, secret, database)
  } catch (error) {
    if (!(error instanceof PreparationDeviceUnauthorizedError) || authorized !== null) return databaseUnavailable()
    // A confirmed 401 can request one new official authorization. Network
    // failures, forbidden targets and malformed/mismatched replies cannot.
    authorized = await authorizePreparation(true)
    result.authorization = 'authorized'
    secret = readDeviceSecret(keychain, projectId, issuer)
    if (!secret) throw new Error('A identidade reautorizada ficou indisponível.')
    try { confirmedDatabase = await confirmPreparationDatabase(projectId, issuer, secret, database) }
    catch { return databaseUnavailable() }
  }
  result.databaseStatus = 'confirmed'
  let runtime: ProjectRuntime
  try {
    runtime = await ensureProjectRuntime(cwd, stack)
    result.runtimeVersion = runtime.version
  } catch {
    result.issues.push('Não foi possível preparar o Node compatível. A autorização e a configuração foram preservadas; execute prepare novamente.')
    return finish()
  }
  let preview = output(cwd, runtime, ['scripts/preview.mjs', 'status'])
  result.previewUrl = previewStatusUrl(preview)
  const dependenciesReady = fs.existsSync(path.join(cwd, 'node_modules')) &&
    output(cwd, runtime, [runtime.npm, 'ls', '--depth=0', '--offline']) !== null
  if (dependenciesReady) result.dependencies = 'reused'
  else {
    if (previewStatusHealthy(preview)) {
      result.issues.push('O preview saudável foi preservado. Dependências precisam de atualização antes de concluir a preparação.')
      return finish()
    }
    try {
      npm(cwd, runtime, ['ci'])
      result.dependencies = 'installed'
    } catch {
      result.issues.push('A instalação de dependências falhou. A autorização e a configuração foram preservadas; execute prepare novamente.')
      return finish()
    }
  }

  const linkedRef = optionalSetupFile(cwd, 'supabase/.temp/project-ref')?.trim()
  const projectRef = confirmedDatabase.projectRef
  let databaseReady = projectRef === null || linkedRef === projectRef
  // Only the freshly authenticated development response authorizes this link.
  // A resumed install reuses device identity; it does not repeat Supremo's
  // browser flow just because Supabase has not written its local link yet.
  if (!databaseReady && !linkedRef && projectRef !== null) {
    const dbPassword = authorized?.supabase?.dbPassword
    try {
      const linked = await linkSupabaseRemote(cwd, { projectRef, ...(dbPassword === undefined ? {} : { dbPassword }) })
      databaseReady = linked && optionalSetupFile(cwd, 'supabase/.temp/project-ref')?.trim() === projectRef
    } catch { databaseReady = false }
  }
  if (!databaseReady) {
    result.issues.push('O banco development foi confirmado no Supremo, mas o link local do Supabase não foi concluído. Execute prepare novamente para retomar; o preview foi preservado.')
  }
  let setupSucceeded = false
  try { npm(cwd, runtime, ['run', 'setup:local']); setupSucceeded = true }
  catch { result.issues.push('setup:local falhou; execute prepare novamente para retomar.') }

  const cli = path.join(cwd, 'node_modules/supremo-cli/dist/bin.js')
  const daemonBefore = output(cwd, runtime, [cli, 'daemon', '--status'])
  const daemonRunning = (source: string | null): boolean => {
    if (!daemonCliOutputLooksValid(source) || source === null) return false
    return (JSON.parse(source) as { running: boolean }).running
  }
  if (!daemonRunning(daemonBefore)) {
    try { execFileSync(runtime.node, [cli, 'daemon', '--ensure'], { cwd, env: runtime.env, stdio: 'inherit' }) }
    catch { result.issues.push('Não foi possível iniciar o daemon local.') }
  }
  const daemonAfter = output(cwd, runtime, [cli, 'daemon', '--status'])
  if (!previewStatusHealthy(preview)) {
    try { npm(cwd, runtime, ['run', 'preview:ensure']) }
    catch { result.issues.push('Não foi possível iniciar o preview local.') }
    preview = output(cwd, runtime, ['scripts/preview.mjs', 'status'])
  }
  const host = opts.host ?? (process.env.CLAUDECODE ? 'claude-code' : 'codex')
  const adapter = inspectHostAdapters(cwd).adapters[host]
  const readiness = validateLocalReadiness({
    projectJsonOk: checkoutProject(cwd, issuer) === projectId,
    hasDaemonIdentity: hasIdentity, daemonRunning: daemonRunning(daemonAfter),
    npmScriptsCompatible: daemonCliOutputLooksValid(daemonAfter), previewHealthy: previewStatusHealthy(preview),
    setupSucceeded, gitHooksVerified: gitHooksVerified(cwd), lifecycleVerified: adapter.verified,
    validationWorkerAvailable: validationWorkerHealthy(cwd), databaseEnvironmentReady: databaseReady,
    integrationMode: adapter.integrationMode,
  })
  Object.assign(result, readiness, { issues: [...result.issues, ...readiness.issues, ...adapter.issues], previewUrl: previewStatusUrl(preview) })
  if (result.issues.length > readiness.issues.length + adapter.issues.length) {
    result.ok = false
    result.state = 'not_ready'
  }
  return finish()
}
