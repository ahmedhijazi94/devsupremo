import fs from 'node:fs'
import path from 'node:path'

/** Runtime state may not redirect writes outside the project through symlinks. */
export function ensureRuntimeDirectory(cwd: string, relative: string): string {
  if (!/^\.supremo(?:\/[a-z0-9-]+)*$/.test(relative)) throw new Error('Diretório de runtime inválido.')
  const segments = relative.split('/')
  for (let index = 0; index <= segments.length; index++) {
    const directory = path.join(cwd, ...segments.slice(0, index))
    const entry = fs.lstatSync(directory, { throwIfNoEntry: false })
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error('Diretório de runtime não regular.')
    if (!entry) fs.mkdirSync(directory, { mode: 0o700 })
  }
  return path.join(cwd, relative)
}
