import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import pkg from '../package.json'
import { readStableFile } from './stable-file'
import { readJson, writeJson } from './turn-workspace'

const artifactSchema = z.object({ version: z.string().max(80), digest: z.string().regex(/^[a-f0-9]{64}$/) })
const receiptSchema = artifactSchema.extend({ protocolVersion: z.literal(1), queueProtocol: z.literal(2), pid: z.number().int().positive(), startedAt: z.number().finite() })
export type RuntimeArtifact = z.infer<typeof artifactSchema>
const receiptPath = (cwd: string): string => path.join(cwd, '.supremo/checkpoints/runtime.json')
export function runtimeArtifact(cwd: string, directory: string): RuntimeArtifact | null {
  try {
    const manifest = z.object({ name: z.literal('supremo-cli'), version: z.string().max(80) }).parse(JSON.parse(readStableFile(path.join(directory, 'package.json'), 64 * 1024).content))
    // Installed file dependencies may be symlinks; resolve the package root,
    // then inspect every executable component under that real directory.
    const real = fs.realpathSync(directory)
    const bytes = readStableFile(path.join(real, 'dist/bin.js'), 32 * 1024 * 1024, real).content
    return { version: manifest.version, digest: crypto.createHash('sha256').update(bytes).digest('hex') }
  } catch { return null }
}
/** Captured once at daemon startup, never recalculated from a replaced executable. */
export function recordActiveRuntime(cwd: string): void {
  const executable = process.argv[1] ? fs.realpathSync(process.argv[1]) : null
  if (!executable) throw new Error('Executável ativo não identificado.')
  const digest = crypto.createHash('sha256').update(readStableFile(executable, 32 * 1024 * 1024).content).digest('hex')
  writeJson(receiptPath(cwd), { version: pkg.version, digest, protocolVersion: 1, queueProtocol: 2, pid: process.pid, startedAt: Date.now() })
}
export function inspectRuntimeVersions(cwd: string): {
  bundled: RuntimeArtifact | null; resolved: RuntimeArtifact | null;
  active: z.infer<typeof receiptSchema> | null; compatible: boolean; updateRequired: boolean
} {
  const bundled = runtimeArtifact(cwd, path.join(cwd, 'tools/supremo-cli'))
  const resolved = runtimeArtifact(cwd, path.join(cwd, 'node_modules/supremo-cli'))
  let active: z.infer<typeof receiptSchema> | null = null
  try {
    const parsed = receiptSchema.safeParse(readJson(receiptPath(cwd)))
    const pid = Number(fs.readFileSync(path.join(cwd, '.supremo/checkpoints/daemon.pid'), 'utf8'))
    if (parsed.success && parsed.data.pid === pid) {
      process.kill(pid, 0)
      active = parsed.data
    }
  } catch { active = null }
  const compatible = !!resolved && !!active && resolved.digest === active.digest && resolved.version === active.version
    && (!bundled || (bundled.digest === resolved.digest && bundled.version === resolved.version))
  return { bundled, resolved, active, compatible, updateRequired: !compatible }
}
