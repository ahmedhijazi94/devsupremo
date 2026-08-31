import { posix } from 'node:path'

/**
 * Lógica pura do workspace do companion — isolamento e detecção. Puro de
 * propósito: é aqui que mora a garantia de que o Projeto A nunca toca o
 * filesystem do Projeto B, e de que uma edição não escapa do diretório do
 * projeto. Sem I/O, então dá para provar por teste.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Diretório isolado de um projeto: base/<userId>/<projectId>. Um por
 * user+project — nunca compartilhado. Rejeita ids fora do formato para nada
 * conseguir subir de diretório via id adulterado.
 */
export function workspaceDir(
  baseDir: string,
  userId: string,
  projectId: string,
): string {
  if (!UUID.test(userId) || !UUID.test(projectId)) {
    throw new Error('user/project inválido para workspace.')
  }
  return posix.join(baseDir, userId, projectId)
}

export type PackageManager = 'pnpm' | 'yarn' | 'npm'

/** Detecta o gerenciador pelo lockfile — não assume npm. */
export function detectPackageManager(repoFiles: string[]): PackageManager {
  const set = new Set(repoFiles)
  if (set.has('pnpm-lock.yaml')) return 'pnpm'
  if (set.has('yarn.lock')) return 'yarn'
  return 'npm' // package-lock.json ou nada → npm
}

export function installCommand(pm: PackageManager): string[] {
  if (pm === 'pnpm') return ['pnpm', 'install', '--frozen-lockfile']
  if (pm === 'yarn') return ['yarn', 'install', '--frozen-lockfile']
  return ['npm', 'ci']
}

export function devCommand(pm: PackageManager): string[] {
  // Todos os projetos do Supremo expõem o script "dev".
  if (pm === 'pnpm') return ['pnpm', 'run', 'dev']
  if (pm === 'yarn') return ['yarn', 'dev']
  return ['npm', 'run', 'dev']
}

/**
 * Resolve o caminho ABSOLUTO seguro de uma edição dentro do workspace do
 * projeto. Rejeita traversal (`..`), caminho absoluto e qualquer coisa que
 * resolva para fora do diretório do projeto. É a fronteira que impede um
 * apply_edits de escrever fora do projeto — inclusive noutro projeto.
 */
export function safeEditPath(
  projectWorkspaceDir: string,
  relPath: string,
): string {
  if (!relPath || relPath.startsWith('/') || relPath.includes('\0')) {
    throw new Error(`Caminho inválido: ${relPath}`)
  }
  const base = posix.normalize(projectWorkspaceDir)
  const resolved = posix.normalize(posix.join(base, relPath))
  // Tem que estar ESTRITAMENTE dentro do workspace do projeto.
  if (resolved !== base && !resolved.startsWith(base + '/')) {
    throw new Error(`Caminho escapa do workspace: ${relPath}`)
  }
  return resolved
}

/**
 * Porta do dev server por projeto, determinística dentro de uma faixa. Duas
 * abas do mesmo projeto reusam a porta; projetos diferentes não colidem no caso
 * comum. Colisão real é resolvida por quem sobe o processo (tenta a próxima).
 */
export function preferredPort(projectId: string, base = 3100, span = 800): number {
  let hash = 0
  for (const ch of projectId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return base + (hash % span)
}
