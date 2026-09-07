import { z } from 'zod'

const sha = z.string().regex(/^[a-f0-9]{40}$/)

/** Status-only telemetry. No code, prompt, path, environment value or log is accepted. */
export const localCheckpointReportSchema = z.object({
  deviceSecret: z.string().min(10).max(256),
  projectId: z.string().uuid(),
  checkpointId: z.string().uuid(),
  commitSha: sha,
  createdAt: z.string().datetime(),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  validationStatus: z.enum(['pending', 'running', 'passed', 'failed', 'deferred']),
  validatedSha: sha.nullable(),
  uploadStatus: z.enum(['local', 'upload_pending', 'push_failed']),
}).strict().superRefine((report, ctx) => {
  if (report.validatedSha !== null && report.validatedSha !== report.commitSha) {
    ctx.addIssue({ code: 'custom', message: 'Validation belongs to another commit.' })
  }
  if (['passed', 'deferred'].includes(report.validationStatus) && report.validatedSha !== report.commitSha) {
    ctx.addIssue({ code: 'custom', message: 'Completed validation requires its exact commit.' })
  }
})

export type LocalCheckpointReport = z.infer<typeof localCheckpointReportSchema>

/** A local report describes development, never approval to publish or integrate. */
export function localCheckpointPresentation(validation: unknown, upload: unknown): {
  label: string; summary: string; state: 'pending' | 'failed'
} {
  if (validation === 'failed') return {
    label: 'Pendência local', state: 'failed',
    summary: 'Alteração salva no computador. A verificação local encontrou uma pendência; esta versão ainda não foi publicada.',
  }
  if (upload === 'push_failed') return {
    label: 'Envio interrompido', state: 'failed',
    summary: 'Alteração salva no computador. O envio precisa de atenção.',
  }
  if (validation === 'running' || validation === 'pending') return {
    label: 'Salvo no computador', state: 'pending',
    summary: 'Checkpoint registrado. A checagem de envio ocorre em background; a versão ainda não foi publicada.',
  }
  return {
    label: 'Envio pendente', state: 'pending',
    summary: 'Checkpoint registrado. Aguardando envio para a validação do CI; isso ainda não confirma aprovação.',
  }
}

/** Limits bytes while streaming, including requests without Content-Length. */
export async function readLocalReportBody(request: Request): Promise<unknown> {
  const limit = 4096
  if (Number(request.headers.get('content-length')) > limit || !request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); return null }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
}
