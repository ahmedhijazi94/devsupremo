import 'server-only'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { authorizeProjectOperation } from '../backend-operations/server'
import { connectionCredential, readProviderConnection, verifyIntegrationOwner, type IntegrationAuthority } from '../provider-connections/server'
import { integrationOptionsSchema, integrationReceiptSchema, IntegrationError, type IntegrationOptions, type IntegrationReceipt } from './contract'
import { runIntegration, type IntegrationPort } from './service'
import { protectedProviderRequest } from './transport'
import { backendOperationStore } from '../backend-operations/store'
import { assertSamePolicy } from '../backend-operations/policy'
import { authorizeOAuthCredentialUse } from '../provider-connections/oauth-server'

export async function runAuthorizedIntegration(authority: IntegrationAuthority, raw: IntegrationOptions): Promise<IntegrationReceipt> {
  const options = integrationOptionsSchema.parse(raw)
  const connection = await readProviderConnection(authority, options.connectionId)
  const capability = options.operation === 'github-repository' || options.operation === 'generic-call' && connection.contract?.operations.find(operation => operation.name === options.name)?.method === 'GET' ? 'integrations.read' : 'integrations.invoke'
  let binding: { policyId: string; revision: string } | undefined
  const budget = backendOperationStore(authority.client, { ownerId: authority.ownerId, projectId: authority.projectId, id: options.operationId, capability, input: options })
  const authorize = async () => {
    await verifyIntegrationOwner(authority)
    const current = await authorizeProjectOperation({ ...authority, environment: connection.environment }, capability, { resource: connection.id, rows: 1 })
    if (binding) assertSamePolicy(binding, current)
    binding ??= current
  }
  let claimToken: string | null = null
  const scoped = () => authority.client.from('integration_sessions').select('id,request_hash,receipt,created_at,claim_token,claim_expires_at').eq('id', options.operationId).eq('user_id', authority.ownerId).eq('project_id', authority.projectId).eq('connection_id', options.connectionId)
  const port: IntegrationPort = {
    authorize, connection: id => readProviderConnection(authority, id), credential: value => connectionCredential(authority, value), now: () => new Date(), request: protectedProviderRequest,
    async start(input, hash) {
      await authorize()
      // The shared ledger reserves the hourly budget once. Reconciliation stays
      // in the integration session, which can verify an accepted remote effect.
      await budget.claim(binding!)
      const receipt: IntegrationReceipt = { operationId: input.operationId, connectionId: input.connectionId, operation: input.operation, status: 'running', resourceId: null, effectVerified: false, evidence: {}, observedAt: new Date().toISOString(), valuesReceived: false }
      const inserted = await authority.client.from('integration_sessions').upsert({ id: input.operationId, user_id: authority.ownerId, project_id: authority.projectId, connection_id: input.connectionId, request_hash: hash, receipt }, { onConflict: 'id', ignoreDuplicates: true })
      if (inserted.error) throw new IntegrationError('Não foi possível registrar a operação. Confira a migration 034 do motor.', 'unavailable')
      const found = await scoped().maybeSingle()
      if (found.error || !found.data) throw new IntegrationError('Operação não encontrada neste projeto.', 'forbidden')
      const row = z.object({ request_hash: z.string(), created_at: z.string(), receipt: integrationReceiptSchema }).parse(found.data)
      return { requestHash: row.request_hash, createdAt: row.created_at, receipt: row.receipt }
    },
    async claim(id) {
      await authorize(); claimToken = randomUUID()
      const result = await authority.client.rpc('claim_integration_session', { p_id: id, p_user_id: authority.ownerId, p_project_id: authority.projectId, p_token: claimToken })
      if (result.error || result.data !== true) { claimToken = null; throw new IntegrationError('Outra execução está ativa ou a conexão foi revogada. Consulte o estado antes de repetir.', 'unavailable') }
    },
    async assertClaim() {
      const result = await scoped().eq('claim_token', claimToken).gt('claim_expires_at', new Date().toISOString()).maybeSingle()
      if (!claimToken || result.error || !result.data) throw new IntegrationError('A reserva expirou. Nenhum novo efeito foi autorizado.', 'forbidden')
    },
    async save(receipt) {
      await authorize(); await port.assertClaim()
      const result = await authority.client.from('integration_sessions').update({ receipt: integrationReceiptSchema.parse(receipt) }).eq('id', options.operationId)
        .eq('user_id', authority.ownerId).eq('project_id', authority.projectId).eq('claim_token', claimToken).gt('claim_expires_at', new Date().toISOString()).select('id').maybeSingle()
      if (result.error || !result.data) throw new IntegrationError('O resultado não foi persistido; consulte a operação antes de repetir.', 'outcome_unknown')
      await port.assertClaim()
      const mirrored = await authority.client.from('project_backend_operations').update({ state: receipt.status === 'completed' ? 'succeeded' : receipt.status === 'outcome_unknown' ? 'uncertain' : receipt.status === 'failed' ? 'failed' : 'verifying',
        message: receipt.effectVerified ? 'Efeito da integração verificado.' : 'Consulte o recibo da integração; efeito externo ainda não confirmado.', result: { integrationReceipt: receipt }, updated_at: new Date().toISOString(), lease_expires_at: new Date(Date.now() + 120000).toISOString() })
        .eq('id', options.operationId).eq('user_id', authority.ownerId).eq('project_id', authority.projectId).eq('capability', capability).select('id').maybeSingle()
      if (mirrored.error || !mirrored.data) throw new IntegrationError('Recibo da integração salvo, mas o histórico comum não foi confirmado.', 'outcome_unknown')
    },
    async release() {
      if (!claimToken) return
      const result = await authority.client.from('integration_sessions').update({ claim_token: null, claim_expires_at: null }).eq('id', options.operationId).eq('user_id', authority.ownerId).eq('project_id', authority.projectId).eq('claim_token', claimToken)
      if (result.error) throw new IntegrationError('Resultado registrado, mas a reserva permanece ativa por até dois minutos.', 'unavailable')
    },
  }
  return budget.withAuthorizationContext(async () => {
    await authorize()
    if (!connection.oauth && !connection.credentialId) throw new IntegrationError('A conexão não tem credencial disponível.', 'forbidden')
    if (connection.oauth) await authorizeOAuthCredentialUse(authority, connection.id)
    else await authorizeProjectOperation({ ...authority, environment: connection.environment }, 'credentials.use', { resource: connection.credentialId! })
    await budget.checkAuthorization()
    return runIntegration(port, options)
  })
}
export async function listIntegrationSessions(authority: IntegrationAuthority): Promise<IntegrationReceipt[]> {
  await verifyIntegrationOwner(authority)
  const result = await authority.client.from('integration_sessions').select('receipt').eq('user_id', authority.ownerId).eq('project_id', authority.projectId).order('created_at', { ascending: false }).limit(100)
  if (result.error) throw new IntegrationError('Histórico de integrações indisponível.', 'unavailable')
  return z.array(z.object({ receipt: integrationReceiptSchema })).parse(result.data).map(row => row.receipt)
}
