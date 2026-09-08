import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { secretEntrySchema } from '../../../src/lib/secret-requests/contract'
import { jobsManifestSchema, jobManifestEntrySchema } from '../../../src/lib/database-jobs/policy'

// CLI and server share the same pure declarative contracts.
export const jobIdSchema = jobManifestEntrySchema.shape.id
export const jobManifestSchema = jobsManifestSchema

export const requestedSecretSchema = secretEntrySchema
export type RequestedSecret = z.infer<typeof requestedSecretSchema>
export const secretRequestOptionsSchema = z.object({ requests: z.array(requestedSecretSchema).min(1).max(20) }).strict()

/** Fixed, declarative source file; the agent cannot send SQL, credentials or an
 * arbitrary path through the privileged daemon channel. */
export function readJobManifest(cwd: string): z.infer<typeof jobManifestSchema> {
  const directory = path.join(cwd, 'supabase')
  if (fs.realpathSync(directory) !== path.join(fs.realpathSync(cwd), 'supabase')) throw new Error('Manifesto de tarefas fora do projeto.')
  const descriptor = fs.openSync(path.join(directory, 'jobs.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const stat = fs.fstatSync(descriptor), maximum = 32 * 1024
    if (!stat.isFile() || stat.size > maximum) throw new Error('Manifesto de tarefas inválido ou muito grande.')
    const bytes = Buffer.alloc(maximum + 1)
    let length = 0
    while (length < bytes.length) {
      const count = fs.readSync(descriptor, bytes, length, bytes.length - length, length)
      if (!count) break
      length += count
    }
    if (length > maximum) throw new Error('Manifesto de tarefas muito grande.')
    return jobManifestSchema.parse(JSON.parse(bytes.toString('utf8', 0, length)))
  } finally { fs.closeSync(descriptor) }
}

/** Explicitly whitelist metadata, even if an upstream regression adds a value. */
export function secretResponse(raw: unknown, projectId: string, issuer: string): unknown {
  const parsed = z.object({ projectId: z.literal(projectId), requests: z.array(z.object({
    id: z.string().uuid(), name: z.string().max(128), description: z.string().max(1000).nullable(),
    target: z.enum(['supabase', 'vercel']), environment: z.enum(['development', 'preview', 'production']),
    targetRef: z.string().min(1).max(256), status: z.enum(['pending', 'fulfilled']),
  })).max(200) }).parse(raw)
  return { ...parsed, formUrl: `${issuer}/projects/${projectId}#secrets`, valuesReceived: false }
}
