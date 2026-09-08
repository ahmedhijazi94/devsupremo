import { z } from 'zod'
import { describeEnvironment } from '@/lib/database-environment/policy'

import { secretTargetSchema, secretEnvironmentSchema, secretEntrySchema } from './contract'
export { secretTargetSchema, secretEnvironmentSchema, secretNameSchema, secretEntrySchema } from './contract'

const identity = { projectId: z.string().uuid(), deviceSecret: z.string().min(10).max(256) }
export const secretsRequestSchema = z.discriminatedUnion('operation', [
  z.object({ ...identity, operation: z.literal('request'), requests: z.array(secretEntrySchema).min(1).max(20) }).strict(),
  z.object({ ...identity, operation: z.literal('status') }).strict(),
])
export const saveSecretSchema = z.object({ projectId: z.string().uuid(), requestId: z.string().uuid(), value: z.string().min(1).max(16384).refine((value) => value.trim().length > 0 && !value.includes('\0')) }).strict()
export const dismissSecretSchema = saveSecretSchema.omit({ value: true })
export type SecretEntry = z.infer<typeof secretEntrySchema>
export type SecretTarget = z.infer<typeof secretTargetSchema>
export type SecretEnvironment = z.infer<typeof secretEnvironmentSchema>
export interface SecretBinding { target: SecretTarget; environment: SecretEnvironment; targetRef: string; accountId: string }
export interface SecretRequestView {
  id: string; name: string; description: string | null; target: SecretTarget | null
  environment: SecretEnvironment | null; targetRef: string | null; status: 'pending' | 'fulfilled'
}
export interface SecretRequestRecord extends SecretRequestView { accountId: string | null }
export class SecretRequestError extends Error {}
export function safeSecretError(error: unknown): string {
  return error instanceof SecretRequestError ? error.message : 'Não foi possível concluir a operação de secrets. Verifique o vínculo e tente novamente.'
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
  return { id: record.id, name: record.name, description: record.description, target: record.target, environment: record.environment, targetRef: record.targetRef, status: record.status }
}
