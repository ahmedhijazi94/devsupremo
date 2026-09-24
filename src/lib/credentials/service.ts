import 'server-only'
import { z } from 'zod'
import { SecretRequestError, type SecretRequestRecord } from '@/lib/secret-requests/policy'
import { fulfillSecret, type SecretRequestPort } from '@/lib/secret-requests/service'
import { credentialNameSchema, credentialView, type ProjectCredentialView } from './contract'
import { decryptCredential, encryptCredential, type CredentialEncryptionContext } from './crypto'

export interface CredentialRecord extends ProjectCredentialView { userId: string; projectId: string; encryptedValue: string }
export interface CredentialPort {
  userId: string
  projectId: string
  authorize(): Promise<void>
  list(): Promise<ProjectCredentialView[]>
  find(id: string): Promise<CredentialRecord | null>
  insert(record: CredentialRecord): Promise<void>
  remove(id: string): Promise<void>
  audit(action: 'saved' | 'used' | 'removed', id: string, requestId?: string): Promise<void>
}
function context(port: CredentialPort, record: CredentialRecord): CredentialEncryptionContext {
  if (record.userId !== port.userId || record.projectId !== port.projectId) throw new SecretRequestError('Credencial não encontrada neste projeto.')
  return { id: record.id, userId: port.userId, projectId: port.projectId, environment: record.environment }
}
export function assertRememberable(record: SecretRequestRecord): void {
  if (record.configuration?.kind === 'supabase-user-password' || !credentialNameSchema.safeParse(record.name).success)
    throw new SecretRequestError('Senhas de contas de usuários não podem ser guardadas ou reutilizadas pelo cofre.')
}
export async function listProjectCredentials(port: CredentialPort): Promise<ProjectCredentialView[]> {
  await port.authorize()
  return (await port.list()).map(credentialView)
}
export async function rememberCredential(port: CredentialPort, request: SecretRequestRecord, value: string): Promise<void> {
  await port.authorize()
  assertRememberable(request)
  if (request.status !== 'fulfilled' || !request.environment) throw new SecretRequestError('Confirme a configuração antes de guardar a credencial.')
  const now = new Date().toISOString()
  const scope = { id: request.id, userId: port.userId, projectId: port.projectId, environment: request.environment }
  const record = { ...scope, name: credentialNameSchema.parse(request.name), createdAt: now, updatedAt: now, encryptedValue: encryptCredential(value, scope) }
  await port.audit('saved', record.id, request.id)
  await port.authorize()
  // Insert-only: a reused reference can never silently change its value.
  await port.insert(record)
}
export async function assertCredentialAvailable(port: CredentialPort, id: string): Promise<void> {
  await port.authorize()
  const record = await port.find(id)
  if (!record) throw new SecretRequestError('A credencial foi removida do cofre. Solicite um novo campo seguro.')
  context(port, record)
}
export async function applyCredential(port: CredentialPort, secrets: SecretRequestPort, requestId: string, credentialId: string): Promise<void> {
  z.string().uuid().parse(requestId); z.string().uuid().parse(credentialId)
  await port.authorize()
  const credential = await port.find(credentialId)
  if (!credential) throw new SecretRequestError('Credencial não encontrada neste projeto. Solicite um campo seguro.')
  const scope = context(port, credential)
  // Authenticate the destination before decryption; fulfill revalidates it before claiming delivery.
  await secrets.authorize()
  const request = await secrets.find(requestId)
  const validate = (record: SecretRequestRecord) => {
    assertRememberable(record)
    if (record.environment !== credential.environment) throw new SecretRequestError('A credencial pertence a outro ambiente. Use uma credencial do ambiente solicitado.')
  }
  if (!request) throw new SecretRequestError('Pedido não encontrado neste projeto.')
  validate(request)
  const value = decryptCredential(credential.encryptedValue, scope)
  await port.audit('used', credential.id, requestId)
  await assertCredentialAvailable(port, credential.id)
  await fulfillSecret(secrets, requestId, value, validate)
}
export async function revokeCredential(port: CredentialPort, id: string): Promise<void> {
  z.string().uuid().parse(id)
  await port.authorize()
  const record = await port.find(id)
  if (!record) return
  context(port, record)
  await port.audit('removed', id)
  await port.authorize()
  await port.remove(id)
}
