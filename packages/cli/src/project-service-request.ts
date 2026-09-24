import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { secretConfigurationSchema, secretEntrySchema } from '../../../src/lib/secret-requests/contract'
import { jobsManifestSchema, jobManifestEntrySchema } from '../../../src/lib/database-jobs/policy'

// CLI and server share the same pure declarative contracts.
export const jobIdSchema = jobManifestEntrySchema.shape.id
export const jobManifestSchema = jobsManifestSchema

export const requestedSecretSchema = secretEntrySchema
export type RequestedSecret = z.infer<typeof requestedSecretSchema>
export const secretRequestOptionsSchema = z.object({ requests: z.array(requestedSecretSchema).min(1).max(20) }).strict()
export const credentialIdSchema = z.string().uuid()
export const credentialApplyOptionsSchema = z.object({ requestId: z.string().uuid(), credentialId: credentialIdSchema }).strict()
const secretViewSchema = z.object({
  id: z.string().uuid(), name: z.string().max(128), description: z.string().max(1000).nullable(),
  target: z.enum(['supabase', 'vercel']), environment: z.enum(['development', 'preview', 'production']),
  targetRef: z.string().min(1).max(256), status: z.enum(['pending', 'fulfilled']),
  configuration: secretConfigurationSchema.optional(),
})
export const secretResponseSchema = z.object({ projectId: z.string().uuid(), requests: z.array(secretViewSchema).max(200) })
type SecretView = z.infer<typeof secretViewSchema>

/** A vault reference is useful to the agent; its encrypted or plaintext value is not. */
export function credentialResponse(raw: unknown, projectId: string): unknown {
  const result = z.object({ projectId: z.literal(projectId), credentials: z.array(z.object({
    id: credentialIdSchema, name: z.string().min(1).max(128),
    environment: z.enum(['development', 'preview', 'production']),
    createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
  })).max(1000) }).parse(raw)
  return { ...result, valuesReceived: false }
}

/** Never choose by list order/name alone: the same name can address another
 * environment or a different SMTP sender. The server repeats authorization. */
export function selectRequestedSecrets(requests: SecretView[], expected: RequestedSecret[]): SecretView[] {
  return expected.map(entry => {
    const matches = requests.filter(request => request.name === entry.name && request.target === entry.target
      && request.environment === entry.environment && JSON.stringify(request.configuration) === JSON.stringify(entry.configuration))
    if (matches.length !== 1) throw new Error('O retorno não identifica um único pedido com o destino e a configuração solicitados.')
    return matches[0]!
  })
}

function configurationReceipt(request: SecretView) {
  if (request.status === 'pending') return { status: 'pending' as const, applied: false as const, providerDashboardRequired: false as const }
  const common = { status: 'fulfilled' as const, applied: true as const, execution: 'server_api' as const,
    providerDashboardRequired: false as const, integrationVerified: false as const, deliveryVerified: false as const }
  if (request.configuration?.kind === 'supabase-smtp') return { ...common, kind: 'smtp_configured' as const,
    message: 'O Supremo já configurou o SMTP por API. Não repita a configuração no navegador.',
    nextSteps: ['Ajustar o template com auth configure, se necessário.', 'Conectar o fluxo do app e testar o envio autorizado.'] }
  if (request.configuration?.kind === 'supabase-user-password') return { ...common, kind: 'development_password_updated' as const,
    message: 'A senha da conta de desenvolvimento foi atualizada por API.', nextSteps: ['Informar a atualização; o login ainda precisa ser verificado.'] }
  return { ...common, kind: 'environment_secret_installed' as const,
    message: 'O segredo já foi instalado no destino e ambiente indicados por API.',
    nextSteps: ['Implementar ou ajustar o uso no backend.', 'Publicar e testar a integração conforme a autorização do usuário.'] }
}

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
export function secretResponse(raw: unknown, projectId: string, issuer: string, selectedRequestIds?: string[]): unknown {
  const parsed = secretResponseSchema.extend({ projectId: z.literal(projectId) }).parse(raw)
  const selected = selectedRequestIds === undefined ? parsed.requests : selectedRequestIds.map(id => {
    const matches = parsed.requests.filter(request => request.id === id)
    if (matches.length !== 1) throw new Error('O retorno não confirma o pedido de configuração solicitado.')
    return matches[0]!
  })
  const formUrl = `${issuer}/projects/${projectId}#secrets`
  return { ...parsed, requests: parsed.requests.map(request => ({ ...request, receipt: configurationReceipt(request) })),
    formUrl, valuesReceived: false, ...(selectedRequestIds ? { selectedRequestIds } : {}),
    nextAction: selected.some(request => request.status === 'pending')
      ? { kind: 'open_secure_form', formUrl, userInput: 'secret_value' }
      : { kind: 'continue_integration', configurationOnly: true, deliveryVerified: false, providerDashboardRequired: false } }
}
