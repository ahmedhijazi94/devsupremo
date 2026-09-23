import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { sanitizeDiagnostic } from '../../../src/lib/checkpoint/feedback'

export const BROWSER_DIAGNOSTICS_PATH = '.supremo/runtime/browser-diagnostics.json'
const RETENTION_MS = 15 * 60 * 1000
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
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384) return null
    const parsed = recordSchema.safeParse(JSON.parse(fs.readFileSync(filename, 'utf8')))
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
