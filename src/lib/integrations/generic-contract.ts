import { z } from 'zod'
import { IntegrationError } from './error'

export const genericScalarSchema = z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()])
const field = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).refine(value => !/(?:password|secret|token|credential|cookie|authorization|private_key)/i.test(value), 'Campo sensível não pode ser projetado.')
const fieldPath = z.string().max(200).refine(value => value.split('.').every(part => field.safeParse(part).success))
const path = z.string().max(300).regex(/^\/[A-Za-z0-9/_-]*$/).refine(value => !value.includes('//'))
export const connectorOriginSchema = z.string().max(253).refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password && !url.port && !/^\d|\[/.test(url.hostname) && url.hostname.includes('.') && !/(?:localhost|\.local|\.internal|\.test|\.invalid|\.localhost)$/i.test(url.hostname) } catch { return false }
}, 'Use origem HTTPS pública, exata, sem caminho, credenciais ou porta.')
const inputFieldSchema = z.object({ name: field, type: z.enum(['string', 'number', 'boolean']), maxLength: z.number().int().min(1).max(1000).default(200), choices: z.array(genericScalarSchema).min(1).max(30).optional() }).strict()
export const genericOperationSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), method: z.enum(['GET', 'POST', 'PATCH', 'DELETE']), path,
  inputs: z.array(inputFieldSchema).max(16).default([]),
  output: z.array(fieldPath).min(1).max(16),
  // Mutations require a follow-up GET. A resource ID is projected only from this
  // declared field; its characters cannot change the origin/path hierarchy.
  verify: z.object({ path: path.refine(value => !value.endsWith('/')), idField: fieldPath.optional(), matchInputs: z.array(field).max(16).default([]) }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.method === 'GET' && (value.inputs.length || value.verify)) context.addIssue({ code: 'custom', message: 'Consulta genérica usa caminho fixo sem payload.' })
  if (value.method !== 'GET' && !value.verify) context.addIssue({ code: 'custom', message: 'Mutação exige leitura de verificação.' })
  if (new Set(value.inputs.map(input => input.name)).size !== value.inputs.length || new Set(value.output).size !== value.output.length) context.addIssue({ code: 'custom', message: 'Campos duplicados.' })
  if (value.verify?.matchInputs.some(name => !value.inputs.some(input => input.name === name))) context.addIssue({ code: 'custom', message: 'Verificação referencia input desconhecido.' })
  if (value.method !== 'GET' && value.verify?.matchInputs.length === 0) context.addIssue({ code: 'custom', message: 'Mutação exige ao menos um campo de estado para conferir.' })
})
export const genericConnectorSchema = z.object({ version: z.literal(1), origin: connectorOriginSchema,
  authorization: z.enum(['bearer', 'x-api-key']),
  identity: z.object({ path, field: fieldPath, account: z.string().min(1).max(160) }).strict(),
  operations: z.array(genericOperationSchema).min(1).max(12),
}).strict().refine(value => new Set(value.operations.map(operation => operation.name)).size === value.operations.length, 'Operações duplicadas.')
export type GenericConnector = z.infer<typeof genericConnectorSchema>
export type GenericOperation = z.infer<typeof genericOperationSchema>
export function selectedField(raw: unknown, path: string): unknown {
  let value = raw
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, part)) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}
export function validateGenericInputs(operation: GenericOperation, raw: Record<string, z.infer<typeof genericScalarSchema>>): Record<string, z.infer<typeof genericScalarSchema>> {
  if (Object.keys(raw).length !== operation.inputs.length) throw new IntegrationError('Campos do pedido diferem do contrato autorizado.', 'forbidden')
  for (const input of operation.inputs) {
    const value = raw[input.name]
    if (typeof value !== input.type || typeof value === 'string' && (value.length > input.maxLength || /[\u0000-\u001f]/.test(value)) || input.choices && !input.choices.includes(value ?? null)) throw new IntegrationError('Valor fora dos limites do contrato.', 'forbidden')
  }
  return raw
}
export function safeProjectedValue(value: unknown, credential: string): z.infer<typeof genericScalarSchema> {
  const parsed = genericScalarSchema.safeParse(value)
  if (!parsed.success) throw new IntegrationError('Campo de resposta fora do contrato.', 'outcome_unknown')
  if (typeof parsed.data === 'string') {
    const forbidden = [credential, encodeURIComponent(credential), Buffer.from(credential).toString('base64'), Buffer.from(credential).toString('hex')]
    if (forbidden.some(secret => secret.length > 0 && parsed.data!.toString().includes(secret)) || /[\u0000-\u001f]/.test(parsed.data)) throw new IntegrationError('Resposta contém material sensível e foi bloqueada.', 'forbidden')
  }
  return parsed.data
}
export function rejectCredentialEcho(raw: unknown, credential: string): void {
  if (typeof raw === 'string') {
    const representations = [credential, encodeURIComponent(credential), Buffer.from(credential).toString('base64'), Buffer.from(credential).toString('hex')]
    if (representations.some(value => value && raw.includes(value))) throw new IntegrationError('Resposta privada do provedor foi bloqueada.', 'forbidden')
  } else if (raw && typeof raw === 'object') for (const value of Object.values(raw)) rejectCredentialEcho(value, credential)
}
