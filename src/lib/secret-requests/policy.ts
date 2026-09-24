import { z } from 'zod'
import { describeEnvironment } from '@/lib/database-environment/policy'

import { secretTargetSchema, secretEnvironmentSchema, secretEntrySchema, secretConfigurationSchema } from './contract'
export { secretTargetSchema, secretEnvironmentSchema, secretNameSchema, secretEntrySchema, secretConfigurationSchema } from './contract'

const identity = { projectId: z.string().uuid(), deviceSecret: z.string().min(10).max(256) }
export const secretsRequestSchema = z.discriminatedUnion('operation', [
  z.object({ ...identity, operation: z.literal('request'), requests: z.array(secretEntrySchema).min(1).max(20) }).strict(),
  z.object({ ...identity, operation: z.literal('status') }).strict(),
  z.object({ ...identity, operation: z.literal('dismiss'), requestId: z.string().uuid() }).strict(),
  z.object({ ...identity, operation: z.literal('credentials') }).strict(),
  z.object({ ...identity, operation: z.literal('apply'), requestId: z.string().uuid(), credentialId: z.string().uuid() }).strict(),
  z.object({ ...identity, operation: z.literal('revoke-credential'), credentialId: z.string().uuid() }).strict(),
])
export const saveSecretSchema = z.object({ projectId: z.string().uuid(), requestId: z.string().uuid(), value: z.string().min(1).max(16384).refine((value) => value.trim().length > 0 && !value.includes('\0')), remember: z.boolean().optional() }).strict()
export const dismissSecretSchema = saveSecretSchema.pick({ projectId: true, requestId: true })
export type SecretEntry = z.infer<typeof secretEntrySchema>
export type SecretTarget = z.infer<typeof secretTargetSchema>
export type SecretEnvironment = z.infer<typeof secretEnvironmentSchema>
export type SecretConfiguration = z.infer<typeof secretConfigurationSchema>
export interface SecretBinding { target: SecretTarget; environment: SecretEnvironment; targetRef: string; accountId: string }
export interface SecretRequestView {
  id: string; name: string; description: string | null; target: SecretTarget | null
  environment: SecretEnvironment | null; targetRef: string | null; status: 'pending' | 'fulfilled'
  configuration?: SecretConfiguration | null | undefined
}
export interface SecretRequestRecord extends SecretRequestView { accountId: string | null }
export type SecretRequestErrorCode = 'schema_unavailable' | 'access_denied' | 'authentication_failed' | 'storage_unavailable'
export class SecretRequestError extends Error {
  constructor(message: string, readonly code?: SecretRequestErrorCode) { super(message) }
}
export function safeSecretError(error: unknown): string {
  return error instanceof SecretRequestError ? error.message : 'Não foi possível concluir a operação de secrets. Verifique o vínculo e tente novamente.'
}
export function safeSecretFailure(error: unknown): { error: string; errorCode?: SecretRequestErrorCode } {
  return { error: safeSecretError(error), ...(error instanceof SecretRequestError && error.code ? { errorCode: error.code } : {}) }
}
export function requireSecretBinding(input: {
  target: SecretTarget; environment: SecretEnvironment; accountId: string | null; targetRef: string | null; databaseEnvironment: unknown
}): SecretBinding {
  if (!input.accountId || !input.targetRef || !/^[A-Za-z0-9_-]{1,128}$/.test(input.targetRef)) throw new SecretRequestError('Conecte o destino ao projeto antes de solicitar o secret.')
  if (input.target === 'supabase') {
    const state = describeEnvironment(input.databaseEnvironment, input.targetRef)
    if (state.environment === 'unknown' || state.environment !== input.environment) throw new SecretRequestError('O ambiente Supabase solicitado não corresponde ao vínculo registrado do projeto.')
  }
  return { target: input.target, environment: input.environment, accountId: input.accountId, targetRef: input.targetRef }
}
export function assertSameBinding(record: SecretRequestRecord, current: SecretBinding): void {
  if (record.target !== current.target || record.environment !== current.environment || record.targetRef !== current.targetRef || record.accountId !== current.accountId) throw new SecretRequestError('O destino mudou desde o pedido. Dispense este pedido e solicite um novo antes de enviar o valor.')
}
export function secretRequestView(record: SecretRequestRecord): SecretRequestView {
  return { id: record.id, name: record.name, description: record.description, target: record.target, environment: record.environment, targetRef: record.targetRef, status: record.status,
    ...(record.configuration ? { configuration: secretConfigurationSchema.parse(record.configuration) } : {}) }
}
export function sameSecretConfiguration(left: SecretConfiguration | null | undefined, right: SecretConfiguration | null | undefined): boolean {
  // Zod supplies a stable field order and rejects any attempt to smuggle a value into metadata.
  return JSON.stringify(left ? secretConfigurationSchema.parse(left) : null) === JSON.stringify(right ? secretConfigurationSchema.parse(right) : null)
}
export function validateSecretValue(configuration: SecretConfiguration | null | undefined, value: string): void {
  if (!saveSecretSchema.shape.value.safeParse(value).success) throw new SecretRequestError('Informe um valor válido no formulário seguro.')
  if (configuration?.kind === 'supabase-user-password' && (value.length < 8 || new TextEncoder().encode(value).length > 72))
    throw new SecretRequestError('A senha precisa ter pelo menos 8 caracteres e no máximo 72 bytes.')
}
