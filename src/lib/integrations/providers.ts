import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { IntegrationError, type IntegrationConnection, type IntegrationOptions } from './contract'
import type { ProviderTransport } from './transport'
import { genericConnectorSchema, safeProjectedValue, selectedField, validateGenericInputs, type GenericConnector } from './generic-contract'

const productSchema = z.object({ id: z.string(), name: z.string(), livemode: z.literal(false), metadata: z.object({ supremo_operation: z.uuid() }) })
export const TEST_EMAIL_SUBJECT = 'Teste autorizado de integração Supremo'
export const TEST_EMAIL_TEXT = 'Esta mensagem confirma um teste de envio solicitado pelo proprietário do projeto no Supremo.'
export interface ProviderEvidence { resourceId: string; effectVerified: boolean; evidence: Record<string, string | number | boolean | null> }
export function assertConnectionOperation(connection: IntegrationConnection, options: IntegrationOptions): void {
  if (connection.revokedAt || connection.id !== options.connectionId) throw new IntegrationError('Conexão revogada ou diferente da operação.', 'forbidden')
  if (options.operation === 'resend-send-test' && (connection.provider !== 'resend' || !connection.allowedSenders.includes(options.from) || !connection.allowedRecipients.includes(options.to))) throw new IntegrationError('Remetente ou destinatário não autorizado nesta conexão.', 'forbidden')
  if (options.operation === 'stripe-create-test-product' && (connection.provider !== 'stripe-test' || connection.environment !== 'development')) throw new IntegrationError('Este conector permite somente produtos de teste.', 'forbidden')
  if (options.operation === 'github-repository' && (connection.provider !== 'github' || !connection.allowedRepositories.includes(`${options.owner}/${options.repository}`))) throw new IntegrationError('Repositório fora do escopo da conexão.', 'forbidden')
  if (options.operation === 'generic-call') {
    if (connection.provider !== 'generic') throw new IntegrationError('Conexão não autoriza API personalizada.', 'forbidden')
    const operation = genericConnectorSchema.parse(connection.contract).operations.find(item => item.name === options.name)
    if (!operation) throw new IntegrationError('Operação ausente do contrato aprovado.', 'forbidden')
    validateGenericInputs(operation, options.input)
  }
}
export async function inspectProviderIdentity(provider: IntegrationConnection['provider'], credential: string, request: ProviderTransport, credentialId: string, rawContract?: GenericConnector): Promise<{ accountRef: string; accountIdentityVerified: boolean }> {
  if (provider === 'generic') {
    const contract = genericConnectorSchema.parse(rawContract)
    const identity = await request({ provider, method: 'GET', path: contract.identity.path, credential, contract })
    const account = safeProjectedValue(selectedField(identity, contract.identity.field), credential)
    if (String(account) !== contract.identity.account) throw new IntegrationError('API retornou uma conta diferente da aprovada.', 'forbidden')
    return { accountRef: String(account), accountIdentityVerified: true }
  }
  if (provider === 'resend') {
    if (!/^re_[A-Za-z0-9_-]{10,}$/.test(credential)) throw new IntegrationError('A referência não contém uma chave Resend compatível.')
    // Resend has no general identity endpoint for restricted sending keys.
    return { accountRef: `credential:${credentialId}`, accountIdentityVerified: false }
  }
  if (provider === 'stripe-test') {
    if (!/^(sk|rk)_test_[A-Za-z0-9]{10,}$/.test(credential)) throw new IntegrationError('Somente chave Stripe de teste é permitida.', 'forbidden')
    z.object({ livemode: z.literal(false) }).parse(await request({ provider, method: 'GET', path: '/v1/balance', credential }))
    const account = z.object({ id: z.string().regex(/^acct_[A-Za-z0-9]+$/) }).parse(await request({ provider, method: 'GET', path: '/v1/account', credential }))
    return { accountRef: account.id, accountIdentityVerified: true }
  }
  const user = z.object({ id: z.number().int().positive() }).parse(await request({ provider, method: 'GET', path: '/user', credential }))
  return { accountRef: `github:${user.id}`, accountIdentityVerified: true }
}
export function stripeProductId(projectId: string, operationId: string): string {
  return `supremo_${createHash('sha256').update(`${projectId}:${operationId}`).digest('hex').slice(0, 40)}`
}
export async function executeProviderOperation(connection: IntegrationConnection, options: IntegrationOptions, credential: string, request: ProviderTransport,
  progress: (resourceId: string) => Promise<void>, existingResourceId: string | null): Promise<ProviderEvidence> {
  assertConnectionOperation(connection, options)
  if (options.operation === 'generic-call') {
    const contract = genericConnectorSchema.parse(connection.contract), operation = contract.operations.find(item => item.name === options.name)!
    const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: string) => request({ provider: 'generic', contract, method, path, body, credential })
    let observed: unknown, id = existingResourceId
    if (operation.method === 'GET') { observed = await call('GET', operation.path); id = operation.name }
    else {
      const verify = operation.verify!
      if (!id) {
        const created = await call(operation.method, operation.path, JSON.stringify(validateGenericInputs(operation, options.input)))
        id = verify.idField ? z.string().regex(/^[A-Za-z0-9_-]{1,160}$/).parse(selectedField(created, verify.idField)) : 'fixed-resource'
        if (id.includes(credential)) throw new IntegrationError('Identificador sensível bloqueado.', 'forbidden')
        await progress(id)
      }
      observed = await call('GET', verify.path + (verify.idField ? `/${id}` : ''))
      if (verify.matchInputs.some(name => selectedField(observed, name) !== options.input[name])) throw new IntegrationError('Estado observado não corresponde ao pedido.', 'outcome_unknown')
    }
    const evidence: ProviderEvidence['evidence'] = { resourceReadback: true, externalDeliveryVerified: false }
    for (const field of operation.output) evidence[field] = safeProjectedValue(selectedField(observed, field), credential)
    return { resourceId: id!, effectVerified: true, evidence }
  }
  if (options.operation === 'resend-send-test') {
    let id = existingResourceId
    if (!id) {
      const created = z.object({ id: z.uuid() }).parse(await request({ provider: 'resend', method: 'POST', path: '/emails', credential,
        idempotencyKey: `supremo/${options.operationId}`, body: JSON.stringify({ from: options.from, to: [options.to], subject: TEST_EMAIL_SUBJECT, text: TEST_EMAIL_TEXT }) }))
      id = created.id
      await progress(id)
    }
    const observed = z.object({ id: z.uuid(), from: z.string(), to: z.array(z.string()).max(1), subject: z.string(), last_event: z.string().max(80) })
      .parse(await request({ provider: 'resend', method: 'GET', path: `/emails/${z.uuid().parse(id)}`, credential }))
    if (observed.id !== id || observed.from !== options.from || observed.to[0] !== options.to || observed.subject !== TEST_EMAIL_SUBJECT) throw new IntegrationError('Mensagem retornada não corresponde ao teste autorizado.', 'outcome_unknown')
    return { resourceId: id, effectVerified: observed.last_event === 'delivered', evidence: { providerEvent: observed.last_event, messageAccepted: true, messageDelivered: observed.last_event === 'delivered' } }
  }
  if (options.operation === 'stripe-create-test-product') {
    const id = stripeProductId(connection.projectId, options.operationId)
    let found: unknown
    try { found = await request({ provider: 'stripe-test', method: 'GET', path: `/v1/products/${id}`, credential }) }
    catch (error) { if (!(error instanceof IntegrationError) || error.httpStatus !== 404) throw error }
    if (!found) {
      const body = new URLSearchParams({ id, name: options.name, 'metadata[supremo_operation]': options.operationId }).toString()
      const created = productSchema.parse(await request({ provider: 'stripe-test', method: 'POST', path: '/v1/products', credential, body, idempotencyKey: options.operationId }))
      if (created.id !== id || created.metadata.supremo_operation !== options.operationId || created.name !== options.name) throw new IntegrationError('Produto de teste não confirmado.', 'outcome_unknown')
      await progress(id)
    }
    const observed = productSchema.parse(found ?? await request({ provider: 'stripe-test', method: 'GET', path: `/v1/products/${id}`, credential }))
    if (observed.id !== id || observed.name !== options.name || observed.metadata.supremo_operation !== options.operationId) throw new IntegrationError('O produto retornado não corresponde à operação.', 'outcome_unknown')
    return { resourceId: id, effectVerified: true, evidence: { sandbox: true, name: observed.name, productVerified: true, paymentVerified: false } }
  }
  const repo = z.object({ id: z.number().int().positive(), full_name: z.string(), private: z.boolean(), archived: z.boolean(), default_branch: z.string().max(200) })
    .parse(await request({ provider: 'github', method: 'GET', path: `/repos/${options.owner}/${options.repository}`, credential }))
  if (repo.full_name.toLowerCase() !== `${options.owner}/${options.repository}`.toLowerCase()) throw new IntegrationError('Repositório retornado não corresponde ao pedido.', 'forbidden')
  return { resourceId: String(repo.id), effectVerified: true, evidence: { fullName: repo.full_name, private: repo.private, archived: repo.archived, defaultBranch: repo.default_branch } }
}
