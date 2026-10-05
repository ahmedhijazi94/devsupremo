import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { daemonStatus, DAEMON_PID_FILE, runDaemonLoop, stopDaemon } from './daemon'
import { withDaemonControl } from './daemon-lifecycle'
import { readJson, writeJson } from './turn-workspace'

const serviceSchema = z.object({ version: z.literal(1), label: z.string(), plist: z.string(),
  state: z.enum(['active', 'paused', 'removed']), mode: z.literal('launchd') })
const stateFile = (cwd: string): string => path.join(cwd, '.supremo/checkpoints/service.json')
export function serviceStatus(cwd: string): Record<string, unknown> {
  const parsed = serviceSchema.safeParse(readJson(stateFile(cwd)))
  return parsed.success ? { ...parsed.data, availability: 'Retoma no login do usuário; execução depende de computador acordado.' }
    : { mode: 'host', state: 'not_installed', availability: 'Retoma ao abrir o host/projeto; reinicialização automática não instalada.' }
}
const escapeXml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
export function launchAgentPlist(cwd: string, node: string, label: string): string {
  const bundle = path.join(cwd, 'tools/supremo-cli/dist/bin.js')
  const log = path.join(cwd, '.supremo/checkpoints/service.log')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${escapeXml(label)}</string>
<key>ProgramArguments</key><array>${[node, bundle, 'runtime', 'supervise'].map(value => `<string>${escapeXml(value)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${escapeXml(cwd)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${escapeXml(log)}</string><key>StandardErrorPath</key><string>${escapeXml(log)}</string>
</dict></plist>\n`
}
/** Explicit user-level installation only; no sudo, credentials or host permission changes. */
export async function controlRuntimeService(cwd: string, action: string): Promise<Record<string, unknown>> {
  const selected = z.enum(['status', 'install', 'pause', 'resume', 'remove']).parse(action)
  if (selected === 'status') return serviceStatus(cwd)
  if (process.platform !== 'darwin' || !process.getuid) throw new Error('Serviço supervisionado disponível apenas no macOS. Neste sistema, retome ao abrir o projeto.')
  const directory = fs.realpathSync(cwd)
  const label = `app.supremo.daemon.${crypto.createHash('sha256').update(directory).digest('hex').slice(0, 20)}`
  const agents = path.join(os.homedir(), 'Library/LaunchAgents'), plist = path.join(agents, `${label}.plist`)
  const domain = `gui/${process.getuid()}`, target = `${domain}/${label}`
  const launch = (args: string[]): void => { execFileSync('/bin/launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }) }
  const installed = serviceSchema.safeParse(readJson(stateFile(cwd)))
  if (installed.success && (installed.data.label !== label || installed.data.plist !== plist)) throw new Error('Serviço registrado pertence a outro caminho; nenhuma alteração aplicada.')
  if (selected === 'install') {
    if (!fs.existsSync(path.join(cwd, 'tools/supremo-cli/dist/bin.js'))) throw new Error('CLI incluída ausente; prepare o projeto antes de instalar o serviço.')
    fs.mkdirSync(agents, { recursive: true })
    if (fs.lstatSync(agents).isSymbolicLink()) throw new Error('Diretório de serviços não pode ser link simbólico.')
    if (fs.existsSync(plist) && !installed.success) throw new Error('Arquivo de serviço já existe sem recibo do projeto; preserve-o e inspecione antes de instalar.')
    if (installed.success && installed.data.state === 'active' && fs.existsSync(plist)) {
      try { launch(['print', target]); return serviceStatus(cwd) }
      catch { /* A registered but unloaded service can be installed again below. */ }
    }
    if (!await stopDaemon(cwd)) throw new Error('Daemon atual não pôde ser encerrado com segurança.')
    fs.writeFileSync(plist, launchAgentPlist(directory, process.execPath, label), { mode: 0o600 })
    // A failed launch retains a resumable installation receipt, never an active claim.
    writeJson(stateFile(cwd), { version: 1, label, plist, mode: 'launchd', state: 'paused' })
    launch(['enable', target])
    launch(['bootstrap', domain, plist])
  } else {
    if (!installed.success) throw new Error('Serviço deste projeto não instalado.')
    if (selected === 'resume') {
      if (!fs.existsSync(plist)) throw new Error('Serviço removido; instale-o novamente antes de retomar.')
      let loaded = false
      try { launch(['print', target]); loaded = true } catch { loaded = false }
      launch(['enable', target]); if (!loaded) launch(['bootstrap', domain, plist])
    }
    else {
      launch(['disable', target])
      // `print` distinguishes an already unloaded service from a failed bootout.
      let loaded = false
      try { launch(['print', target]); loaded = true } catch { loaded = false }
      if (loaded) launch(['bootout', target])
      if (!await stopDaemon(cwd)) throw new Error('Não foi possível confirmar a parada do serviço.')
      if (selected === 'remove') fs.rmSync(plist, { force: true })
    }
  }
  writeJson(stateFile(cwd), { version: 1, label, plist, mode: 'launchd', state: selected === 'remove' ? 'removed' : selected === 'pause' ? 'paused' : 'active' })
  return serviceStatus(cwd)
}
export async function runSupervisedDaemon(cwd: string): Promise<void> {
  await withDaemonControl(cwd, async () => {
    const current = daemonStatus(cwd)
    if (current.running && current.pid !== process.pid) throw new Error('Outro daemon está ativo; supervisor preservou o processo existente.')
    fs.writeFileSync(path.join(cwd, DAEMON_PID_FILE), String(process.pid), { mode: 0o600 })
  })
  await runDaemonLoop(cwd)
}
