import fs from 'node:fs'
import path from 'node:path'

const sameIdentity = (left: fs.Stats, right: fs.Stats): boolean => left.dev === right.dev && left.ino === right.ino

/** Inspect and read one opened inode, never reopen a checked path. A concurrent
 * rename/rewrite fails closed; all bytes and the executable bit share the proof. */
export function readStableFile(file: string, maximumBytes: number, root?: string): { content: string; mode: number } {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error('Limite de arquivo inválido.')
  const full = path.resolve(file)
  const ancestry: Array<{ name: string; stat: fs.Stats }> = []
  const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const before = fs.fstatSync(fd)
    if (!before.isFile()) throw new Error('O caminho não é um arquivo regular.')
    if (before.size > maximumBytes) throw new Error('Arquivo excede o orçamento de leitura.')
    if (root !== undefined) {
      const base = path.resolve(root)
      const relative = path.relative(base, full)
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Arquivo fora do diretório autorizado.')
      const segments = relative.split(path.sep)
      for (let index = 0; index < segments.length; index++) {
        const name = path.join(base, ...segments.slice(0, index))
        const stat = fs.lstatSync(name)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Diretório de arquivo contém link simbólico ou tipo inválido.')
        ancestry.push({ name, stat })
      }
    }
    const assertLocation = (): void => {
      for (const entry of ancestry) {
        const current = fs.lstatSync(entry.name)
        if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(entry.stat, current)) throw new Error('Diretório mudou durante a leitura do arquivo.')
      }
      const current = fs.lstatSync(full)
      if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(before, current)) throw new Error('Arquivo mudou durante a leitura.')
    }
    assertLocation()
    const chunks: Buffer[] = []
    let length = 0
    while (length <= maximumBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - length))
      const count = fs.readSync(fd, chunk, 0, chunk.length, length)
      if (!count) break
      length += count
      if (length > maximumBytes) throw new Error('Arquivo excede o orçamento de leitura.')
      chunks.push(chunk.subarray(0, count))
    }
    const after = fs.fstatSync(fd)
    if (!sameIdentity(before, after) || !after.isFile() || before.size !== after.size || length !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode) throw new Error('Arquivo foi alterado durante a leitura.')
    assertLocation()
    return { content: Buffer.concat(chunks, length).toString('utf8'), mode: before.mode }
  } finally {
    fs.closeSync(fd)
  }
}
