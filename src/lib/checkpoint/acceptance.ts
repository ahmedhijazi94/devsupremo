import { inflateRawSync } from 'node:zlib'
import { z } from 'zod'

export const MAX_ACCEPTANCE_BYTES = 64 * 1024
export const MAX_ACCEPTANCE_ARCHIVE_BYTES = 96 * 1024

export const acceptanceReportSchema = z.object({
  version: z.literal(1), projectId: z.string().uuid(), sha: z.string().regex(/^[a-f0-9]{40}$/),
  environment: z.literal('development'), runId: z.number().int().positive(), runAttempt: z.number().int().positive(),
  completedAt: z.string().datetime(),
  checks: z.array(z.object({ name: z.string().min(1).max(200), type: z.enum(['unit', 'e2e', 'rls']),
    status: z.enum(['passed', 'failed']) }).strict()).min(1).max(50),
  criterionIds: z.array(z.string().min(1).max(100)).max(100),
}).strict().superRefine((report, context) => {
  if (new Set(report.checks.map((check) => check.name)).size !== report.checks.length ||
    new Set(report.criterionIds).size !== report.criterionIds.length) {
    context.addIssue({ code: 'custom', message: 'Acceptance evidence names and criteria must be unique.' })
  }
})
export type AcceptanceReport = z.infer<typeof acceptanceReportSchema>

/** CRC-32 from the ZIP format. Bounds are enforced before decompression. */
function crc32(content: Buffer): number {
  let crc = 0xffffffff
  for (const byte of content) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Decode one regular acceptance.json entry in memory; never extract files. */
export function readAcceptanceArchive(archive: Buffer): AcceptanceReport {
  const invalid = (): never => { throw new Error('Artefato de aceitação inválido ou acima do limite.') }
  if (archive.length < 100 || archive.length > MAX_ACCEPTANCE_ARCHIVE_BYTES) return invalid()
  const end = archive.length - 22
  if (archive.readUInt32LE(end) !== 0x06054b50 || archive.readUInt16LE(end + 4) !== 0 || archive.readUInt16LE(end + 6) !== 0 ||
    archive.readUInt16LE(end + 8) !== 1 || archive.readUInt16LE(end + 10) !== 1 || archive.readUInt16LE(end + 20) !== 0) return invalid()
  const directorySize = archive.readUInt32LE(end + 12)
  const directory = archive.readUInt32LE(end + 16)
  if (directory < 30 || directory + directorySize !== end || directorySize < 46 || archive.readUInt32LE(directory) !== 0x02014b50) return invalid()
  const flags = archive.readUInt16LE(directory + 8)
  const method = archive.readUInt16LE(directory + 10)
  const crc = archive.readUInt32LE(directory + 16)
  const compressed = archive.readUInt32LE(directory + 20)
  const expanded = archive.readUInt32LE(directory + 24)
  const nameSize = archive.readUInt16LE(directory + 28)
  const extraSize = archive.readUInt16LE(directory + 30)
  const commentSize = archive.readUInt16LE(directory + 32)
  const fileKind = (archive.readUInt32LE(directory + 38) >>> 16) & 0xf000
  if ((flags & ~0x0808) !== 0 || ![0, 8].includes(method) || expanded === 0 || expanded > MAX_ACCEPTANCE_BYTES || compressed > MAX_ACCEPTANCE_BYTES ||
    ![0, 0x8000].includes(fileKind) || archive.readUInt16LE(directory + 34) !== 0 || archive.readUInt32LE(directory + 42) !== 0 ||
    46 + nameSize + extraSize + commentSize !== directorySize || archive.subarray(directory + 46, directory + 46 + nameSize).toString('utf8') !== 'acceptance.json') return invalid()
  if (archive.readUInt32LE(0) !== 0x04034b50 || archive.readUInt16LE(6) !== flags || archive.readUInt16LE(8) !== method) return invalid()
  const localName = archive.readUInt16LE(26)
  const start = 30 + localName + archive.readUInt16LE(28)
  if (start + compressed > directory || archive.subarray(30, 30 + localName).toString('utf8') !== 'acceptance.json') return invalid()
  if ((flags & 8) === 0) {
    if (archive.readUInt32LE(14) !== crc || archive.readUInt32LE(18) !== compressed || archive.readUInt32LE(22) !== expanded || start + compressed !== directory) return invalid()
  } else {
    const descriptor = start + compressed
    const size = directory - descriptor
    if (size !== 12 && size !== 16) return invalid()
    if (size === 16 && archive.readUInt32LE(descriptor) !== 0x08074b50) return invalid()
    const values = descriptor + (size === 16 ? 4 : 0)
    if (archive.readUInt32LE(values) !== crc || archive.readUInt32LE(values + 4) !== compressed || archive.readUInt32LE(values + 8) !== expanded) return invalid()
  }
  const packed = archive.subarray(start, start + compressed)
  const json = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: MAX_ACCEPTANCE_BYTES })
  if (json.length !== expanded || crc32(json) !== crc) return invalid()
  return acceptanceReportSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json)))
}

export function acceptanceMatchesObservation(report: AcceptanceReport, expected: {
  projectId: string; sha: string; runId: number; runAttempt: number; startedAt: string; observedAt: string
}): boolean {
  const completedAt = Date.parse(report.completedAt)
  return report.projectId === expected.projectId && report.sha === expected.sha && report.runId === expected.runId &&
    report.runAttempt === expected.runAttempt && completedAt >= Date.parse(expected.startedAt) && completedAt <= Date.parse(expected.observedAt) + 60_000
}
