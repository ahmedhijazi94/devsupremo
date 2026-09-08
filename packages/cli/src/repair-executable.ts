import fs from 'node:fs'
import path from 'node:path'
import type { RepairRunner } from './repair-runner'

export class RepairRunnerUnavailableError extends Error {
  constructor(runner: RepairRunner) {
    super(`Executor ${runner} indisponível. Disponibilize a CLI no PATH do daemon ou, para Codex no macOS, no aplicativo instalado em Applications. A autocura tentará novamente sem consumir uma tentativa de reparação.`)
    this.name = 'RepairRunnerUnavailableError'
  }
}

interface ExecutableSearch {
  searchPath?: string
  platform?: NodeJS.Platform
  homeDir?: string
  isExecutable?: (file: string) => boolean
}

function isExecutable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}

/** Resolve without launching the agent, inspecting credentials or changing PATH.
 * Relative PATH entries cannot select executables from an application workspace. */
export function resolveRepairExecutable(runner: RepairRunner, search: ExecutableSearch = {}): string {
  const platform = search.platform ?? process.platform
  const paths = platform === 'win32' ? path.win32 : path.posix
  const searchPath = search.searchPath ?? process.env.PATH ?? ''
  const homeDir = search.homeDir ?? process.env.HOME
  const check = search.isExecutable ?? isExecutable
  const names = platform === 'win32' ? [`${runner}.exe`, runner] : [runner]
  const candidates = searchPath.split(platform === 'win32' ? ';' : ':')
    .filter(directory => paths.isAbsolute(directory)).flatMap(directory => names.map(name => paths.join(directory, name)))
  if (platform === 'darwin' && runner === 'codex') {
    const applications = ['/Applications', ...(homeDir && paths.isAbsolute(homeDir) ? [paths.join(homeDir, 'Applications')] : [])]
    for (const directory of applications) {
      for (const app of ['Codex.app', 'ChatGPT.app']) candidates.push(paths.join(directory, app, 'Contents/Resources/codex'))
    }
  }
  for (const candidate of [...new Set(candidates)]) if (check(candidate)) return candidate
  throw new RepairRunnerUnavailableError(runner)
}

export function isRunnerLaunchUnavailable(error: unknown): boolean {
  if (error instanceof RepairRunnerUnavailableError) return true
  if (!(error instanceof Error)) return false
  const launch = error as NodeJS.ErrnoException
  return ['ENOENT', 'EACCES'].includes(launch.code ?? '') && (launch.syscall?.startsWith('spawn ') ?? false)
}
