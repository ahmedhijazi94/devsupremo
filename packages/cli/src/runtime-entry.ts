import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { constants } from 'node:os'
import path from 'node:path'
import { KNOWN_COMMANDS } from './command-guard'
import { readProjectStack } from './framework-runtime'
import { compatibleProjectNode, lookupProjectRuntime, type ProjectRuntime } from './project-runtime'
import { readStableFile } from './stable-file'

/** This is only a discovery hint. Existing commands retain ownership of
 * validation for legacy, incomplete and unrelated project manifests. */
function hasStartManifest(cwd: string): boolean {
  try {
    const source: unknown = JSON.parse(readStableFile(path.join(cwd, 'package.json'), 1024 * 1024, cwd).content)
    if (!source || typeof source !== 'object' || Array.isArray(source)) return false
    const manifest = source as { dependencies?: unknown; devDependencies?: unknown }
    return [manifest.dependencies, manifest.devDependencies].some(packages => {
      if (!packages || typeof packages !== 'object' || Array.isArray(packages)) return false
      return typeof (packages as Record<string, unknown>)['@tanstack/react-start'] === 'string'
    })
  } catch { return false }
}

/** Keep terminal ownership and exit semantics when delegating to the selected
 * Node. The parent never changes its environment or starts background work. */
function runInherited(cwd: string, runtime: ProjectRuntime, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.node, args, { cwd, env: runtime.env, stdio: 'inherit' })
    const forwardInterrupt = (): void => { child.kill('SIGINT') }
    const forwardTermination = (): void => { child.kill('SIGTERM') }
    const cleanup = (): void => {
      process.removeListener('SIGINT', forwardInterrupt)
      process.removeListener('SIGTERM', forwardTermination)
      child.removeListener('error', failed)
      child.removeListener('close', closed)
    }
    const failed = (): void => {
      cleanup()
      reject(new Error('Não foi possível iniciar o runtime local. Retome a preparação deste projeto com supremo prepare.'))
    }
    const closed = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup()
      if (signal) {
        process.exitCode = 128 + (constants.signals[signal] ?? 1)
        process.kill(process.pid, signal)
      } else process.exitCode = code ?? 1
      resolve()
    }
    process.on('SIGINT', forwardInterrupt)
    process.on('SIGTERM', forwardTermination)
    child.once('error', failed)
    child.once('close', closed)
  })
}

/** Read-only boundary for later prompts. Preparation and help cannot trigger
 * discovery/relaunch, and a compatible current executable terminates the loop. */
export async function maybeRelaunchWithProjectRuntime(cwd: string, argv: string[] = process.argv): Promise<boolean> {
  const command = argv[2]
  if (!command || !(KNOWN_COMMANDS as readonly string[]).includes(command) || ['bootstrap', 'prepare'].includes(command)
    || argv.slice(2).some(argument => argument === '--help' || argument === '-h')) return false
  if (compatibleProjectNode('tanstack-start-vite', process.version) || !hasStartManifest(cwd)) return false
  const stack = readProjectStack(cwd)
  if (stack !== 'tanstack-start-vite') return false
  const runtime = await lookupProjectRuntime(cwd, stack)
  if (!runtime || runtime.source === 'current' || !compatibleProjectNode(stack, runtime.version)) return false
  if (fs.realpathSync(runtime.node) === fs.realpathSync(process.execPath)) return false
  const entry = argv[1]
  if (!entry) throw new Error('A entrada da CLI não está disponível para o runtime local.')
  await runInherited(cwd, runtime, [path.resolve(entry), ...argv.slice(2)])
  return true
}

/** The public wrapper accepts supervisor actions only, never executable text or
 * an alternative script. Lookup may reuse a prepared Node but cannot install. */
export async function runPreviewWithProjectRuntime(cwd: string, args: string[]): Promise<void> {
  const action = args[0] ?? 'ensure'
  if (args.length > 1 || !['ensure', 'status', 'stop'].includes(action)) throw new Error('Use runtime-preview ensure, status ou stop.')
  const stack = readProjectStack(cwd)
  const runtime = await lookupProjectRuntime(cwd, stack)
  if (!runtime || !compatibleProjectNode(stack, runtime.version)) {
    throw new Error('O runtime compatível ainda não foi preparado. Autorize a preparação deste projeto e execute supremo prepare.')
  }
  const script = path.resolve(cwd, 'scripts/preview.mjs')
  readStableFile(script, 256 * 1024, cwd)
  await runInherited(cwd, runtime, [script, action])
}
