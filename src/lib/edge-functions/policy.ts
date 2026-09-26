import 'server-only'
import { createHash, createHmac } from 'node:crypto'
import { z } from 'zod'
import { describeEnvironment } from '../database-environment/policy'
import { functionEnvironmentSchema, FUNCTION_HOOK_SECRET_NAME, functionSlugSchema } from './contract'

export class FunctionError extends Error {
  constructor(message: string, readonly status = 409) { super(message); this.name = 'FunctionError' }
}
export function requireFunctionTarget(record: unknown, linkedRef: string | null, options: { expectedRef: string; environment: string }): string {
  const state = describeEnvironment(record, linkedRef)
  if (!functionEnvironmentSchema.safeParse(options.environment).success || state.environment !== options.environment
    || !state.projectRef || state.projectRef !== options.expectedRef)
    throw new FunctionError('Funções exigem ambiente registrado pelo Supremo, seleção explícita e vínculo correspondente. Consulte db status; ambiente desconhecido não é autorizado.')
  return state.projectRef
}
const signingContextSchema = z.object({ ownerId: z.string().uuid(), projectId: z.string().uuid(), projectRef: z.string().regex(/^[a-z0-9_-]+(?![\s\S])/).max(64),
  environment: functionEnvironmentSchema, slug: functionSlugSchema, secretName: z.literal(FUNCTION_HOOK_SECRET_NAME) }).strict()
export type FunctionSigningContext = z.infer<typeof signingContextSchema>

/** Stable, domain-separated server key makes concurrent initial setup converge.
 * The context is assembled only after owner, project and environment authorization. */
export function deriveHookSecret(context: FunctionSigningContext): string {
  const parsed = signingContextSchema.safeParse(context)
  const rawKey = process.env.ENCRYPTION_KEY
  if (!parsed.success || !rawKey || rawKey.length !== 64 || !/^[a-f0-9]{64}$/i.test(rawKey)) throw new FunctionError('Assinatura do hook indisponível; configuração privada do servidor inválida.', 503)
  const key = Buffer.from(rawKey, 'hex')
  try {
    const scope = parsed.data
    const value = createHmac('sha256', key).update(JSON.stringify(['supremo:auth-send-email:signing-key', 'v1',
      scope.ownerId.toLowerCase(), scope.projectId.toLowerCase(), scope.projectRef, scope.environment, scope.slug, scope.secretName])).digest('base64')
    return `v1,whsec_${value}`
  } finally { key.fill(0) }
}
export function isValidHookSecret(value: unknown): value is string {
  if (typeof value !== 'string' || !/^v1,whsec_[A-Za-z0-9+/]{43,172}={0,2}$/.test(value)) return false
  const encoded = value.slice('v1,whsec_'.length)
  const bytes = Buffer.from(encoded, 'base64')
  return bytes.length >= 32 && bytes.length <= 128 && bytes.toString('base64') === encoded
}
export const hookSecretDigest = (value: string): string => createHash('sha256').update(value).digest('hex')
export function hookSignature(secret: string, id: string, timestamp: string, body: string): string {
  if (!isValidHookSecret(secret)) throw new FunctionError('Assinatura privada do hook inválida.')
  return `v1,${createHmac('sha256', Buffer.from(secret.slice('v1,whsec_'.length), 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64')}`
}
