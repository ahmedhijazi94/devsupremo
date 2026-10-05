import 'server-only'
import { createHash } from 'node:crypto'
import { integrationOptionsSchema, integrationReceiptSchema, IntegrationError, type IntegrationConnection, type IntegrationOptions, type IntegrationReceipt } from './contract'
import { assertConnectionOperation, executeProviderOperation, inspectProviderIdentity } from './providers'
import type { ProviderTransport } from './transport'
import { rejectCredentialEcho, safeProjectedValue } from './generic-contract'

export interface IntegrationSession { requestHash: string; createdAt: string; receipt: IntegrationReceipt }
export interface IntegrationPort {
  authorize(): Promise<void>
  connection(id: string): Promise<IntegrationConnection>
  credential(connection: IntegrationConnection): Promise<string>
  start(options: IntegrationOptions, requestHash: string): Promise<IntegrationSession>
  claim(operationId: string): Promise<void>
  assertClaim(): Promise<void>
  save(receipt: IntegrationReceipt): Promise<void>
  release(): Promise<void>
  request: ProviderTransport
  now(): Date
}
export function integrationRequestHash(options: IntegrationOptions): string {
  return createHash('sha256').update(JSON.stringify(integrationOptionsSchema.parse(options))).digest('hex')
}
export async function runIntegration(port: IntegrationPort, raw: IntegrationOptions): Promise<IntegrationReceipt> {
  const options = integrationOptionsSchema.parse(raw)
  await port.authorize()
  const connection = await port.connection(options.connectionId)
  assertConnectionOperation(connection, options)
  const hash = integrationRequestHash(options)
  const session = await port.start(options, hash)
  if (session.requestHash !== hash) throw new IntegrationError('Este ID já pertence a outro pedido. O plano existente foi preservado.', 'forbidden')
  if (session.receipt.status === 'completed') return integrationReceiptSchema.parse(session.receipt)
  const genericMutation = options.operation === 'generic-call' && connection.contract?.operations.find(operation => operation.name === options.name)?.method !== 'GET'
  if (genericMutation && !session.receipt.resourceId && session.receipt.evidence.dispatchAttempted === true) throw new IntegrationError('Mutação anterior sem resultado confirmado. O motor não repetirá a chamada; reconcilie no fornecedor.', 'outcome_unknown')
  // Resend retains idempotency keys for 24h. An unknown send is never replayed
  // after the conservative 20h window; an observed ID can always be read again.
  if (options.operation === 'resend-send-test' && !session.receipt.resourceId && port.now().getTime() - Date.parse(session.createdAt) >= 20 * 3600000)
    throw new IntegrationError('A janela segura de repetição terminou sem ID confirmado. O resultado permanece incerto; nenhum novo email foi enviado.', 'outcome_unknown')
  await port.claim(options.operationId)
  let receipt = { ...session.receipt, status: 'running' as IntegrationReceipt['status'], observedAt: port.now().toISOString() }
  try {
    await port.authorize(); await port.assertClaim()
    const currentSession = await port.start(options, hash)
    if (currentSession.requestHash !== hash) throw new IntegrationError('O pedido persistido mudou.', 'forbidden')
    if (currentSession.receipt.status === 'completed') return currentSession.receipt
    receipt = { ...currentSession.receipt, status: 'running', observedAt: port.now().toISOString() }
    if (genericMutation && !receipt.resourceId && receipt.evidence.dispatchAttempted === true) throw new IntegrationError('Chamada anterior sem resultado confirmado; nenhuma repetição foi enviada.', 'outcome_unknown')
    const credential = await port.credential(connection)
    const request: ProviderTransport = async input => {
      await port.authorize(); await port.assertClaim()
      const current = await port.connection(options.connectionId)
      if (JSON.stringify(current) !== JSON.stringify(connection)) throw new IntegrationError('A conexão mudou durante a operação.', 'forbidden')
      const currentCredential = await port.credential(current) // Detect revocation and OAuth rotation before dispatch.
      const result = await port.request({ ...input, credential: currentCredential })
      rejectCredentialEcho(result, currentCredential)
      rejectCredentialEcho(result, credential)
      return result
    }
    const identity = await inspectProviderIdentity(connection.provider, credential, request, connection.credentialId ?? '', connection.contract)
    if (identity.accountRef !== connection.accountRef || identity.accountIdentityVerified !== connection.accountIdentityVerified) throw new IntegrationError('A credencial não corresponde à conta autorizada.', 'forbidden')
    if (genericMutation && !receipt.resourceId) {
      receipt = { ...receipt, evidence: { dispatchAttempted: true }, observedAt: port.now().toISOString() }
      await port.save(receipt)
    }
    const evidence = await executeProviderOperation(connection, options, credential, request, async resourceId => {
      receipt = { ...receipt, resourceId, status: 'verifying', observedAt: port.now().toISOString() }
      await port.save(receipt)
    }, receipt.resourceId)
    await port.authorize(); await port.assertClaim()
    for (const value of Object.values(evidence.evidence)) safeProjectedValue(value, credential)
    receipt = integrationReceiptSchema.parse({ ...receipt, ...evidence, status: evidence.effectVerified ? 'completed' : 'verifying', observedAt: port.now().toISOString() })
    await port.save(receipt)
    return receipt
  } catch (error) {
    const safe = error instanceof IntegrationError ? error : new IntegrationError('Resposta externa não pôde ser verificada. Consulte esta operação antes de repetir.', 'outcome_unknown')
    receipt = { ...receipt, status: 'outcome_unknown', effectVerified: false, evidence: { ...receipt.evidence, errorCode: safe.code, message: safe.message }, observedAt: port.now().toISOString() }
    await port.save(receipt)
    return receipt
  } finally { await port.release() }
}
