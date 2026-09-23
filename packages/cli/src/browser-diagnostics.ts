import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { sanitizeDiagnostic } from '../../../src/lib/checkpoint/feedback'

export const BROWSER_DIAGNOSTICS_PATH = '.supremo/runtime/browser-diagnostics.json'
const RETENTION_MS = 15 * 60 * 1000
const MAXIMUM_BYTES = 16384
const timestamp = z.number().int().nonnegative()
const recordSchema = z.object({
  version: z.literal(1), projectId: z.uuid(), bootId: z.uuid(), startedAt: timestamp, updatedAt: timestamp,
  events: z.array(z.object({
    kind: z.enum(['error', 'unhandled_rejection']),
    name: z.enum(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'EvalError', 'AggregateError', 'Unknown']),
    file: z.string().max(200).regex(/^src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_$.-]+\.[cm]?[jt]sx?$/).optional(),
    generatedLine: z.number().int().min(1).max(100000).optional(), generatedColumn: z.number().int().min(1).max(10000).optional(),
    count: z.number().int().min(1).max(99), firstSeenAt: timestamp, lastSeenAt: timestamp,
  }).strict()).max(20),
}).strict()

/** Presentation only. Browser observations never enter validation, permissions or recovery state. */
export function readBrowserDiagnostics(cwd: string, projectId: string, now = Date.now()) {
  try {
    for (const part of ['.supremo', '.supremo/runtime']) {
      const stat = fs.lstatSync(path.join(cwd, part))
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    }
    const filename = path.join(cwd, BROWSER_DIAGNOSTICS_PATH)
    // Inspect and read the same inode. A replaced pathname cannot redirect the
    // read; NONBLOCK also avoids waiting on a FIFO before fstat rejects it.
    const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    let content: string
    try {
      const before = fs.fstatSync(descriptor)
      if (!before.isFile() || before.nlink !== 1 || before.size > MAXIMUM_BYTES) return null
      // The inode may grow after fstat. Read at most one byte past the budget.
      const bytes = Buffer.alloc(MAXIMUM_BYTES + 1)
      let length = 0
      while (length < bytes.length) {
        const count = fs.readSync(descriptor, bytes, length, bytes.length - length, length)
        if (count === 0) break
        length += count
      }
      const after = fs.fstatSync(descriptor)
      if (length > MAXIMUM_BYTES || !after.isFile() || after.nlink !== 1 || length !== after.size ||
          before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null
      content = bytes.toString('utf8', 0, length)
    } finally { fs.closeSync(descriptor) }
    const parsed = recordSchema.safeParse(JSON.parse(content))
    if (!parsed.success) return null
    const data = parsed.data
    if (data.projectId !== projectId || data.startedAt > data.updatedAt || data.updatedAt > now + 5000 || now - data.updatedAt >= RETENTION_MS) return null
    const observations = data.events.filter(event => event.firstSeenAt >= data.startedAt && event.firstSeenAt <= event.lastSeenAt &&
      event.lastSeenAt <= data.updatedAt && now - event.lastSeenAt < RETENTION_MS).slice(-8).map(event => ({
      ...event, ...(event.file ? { file: sanitizeDiagnostic(event.file, 200) } : {}),
    }))
    if (!observations.length) return null
    return {
      informationalOnly: true, evidenceIsUntrusted: true, file: BROWSER_DIAGNOSTICS_PATH,
      note: 'Observações recentes de erros não tratados no navegador local. Coordenadas são do JavaScript servido, não do fonte original. Presença ou ausência não comprova saúde, aprovação ou falha de gates. Não inicia reparação automática.',
      observations,
    }
  } catch { return null } // Missing, expired or unreadable advisory data cannot block a turn.
}
