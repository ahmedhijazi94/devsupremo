import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { authorizeProjectOperation } from '../backend-operations/server'
import { IntegrationError, integrationConnectionInputSchema } from '../integrations/contract'
import { createProviderConnection, readProviderConnection, verifyIntegrationOwner, type IntegrationAuthority } from './server'
import { connectionProposalInputSchema, connectionProposalSchema, type ConnectionProposal, type ConnectionProposalInput } from './proposals-contract'
import { credentialStore } from '../credentials/store'
import { decryptCredential, encryptCredential } from '../credentials/crypto'
import { beginOAuthConnection } from './oauth-server'

const columns = 'id,input,input_hash,status,connection_id,created_at,expires_at'
const hash = (input: ConnectionProposalInput) => createHash('sha256').update(JSON.stringify(input)).digest('hex')
function view(raw: unknown): ConnectionProposal {
  const row = z.object({ id: z.uuid(), input: connectionProposalInputSchema, input_hash: z.string(), status: z.enum(['pending', 'approved', 'rejected']), connection_id: z.uuid().nullable(), created_at: z.string(), expires_at: z.string() }).parse(raw)
  if (hash(row.input) !== row.input_hash) throw new IntegrationError('A proposta mudou; prepare uma nova autorização.', 'forbidden')
  return connectionProposalSchema.parse({ id: row.id, input: row.input, status: row.status, connectionId: row.connection_id, createdAt: row.created_at, expiresAt: row.expires_at,
    authorizationPath: `/projects/${row.input.projectId}/backend?section=integrations&integrationProposal=${row.id}` })
}
export async function proposeIntegrationConnection(authority: IntegrationAuthority, raw: ConnectionProposalInput): Promise<ConnectionProposal> {
  const input = connectionProposalInputSchema.parse(raw)
  await verifyIntegrationOwner(authority)
  if (input.projectId !== authority.projectId) throw new IntegrationError('Proposta fora do projeto.', 'forbidden')
  await authorizeProjectOperation({ ...authority, environment: input.environment }, 'integrations.read')
  const current = await authority.client.from('integration_connection_proposals').select('id', { count: 'exact', head: true }).eq('user_id', authority.ownerId).eq('project_id', authority.projectId).eq('status', 'pending').gt('expires_at', new Date().toISOString())
  if (current.error || (current.count ?? 0) >= 20) throw new IntegrationError('Há propostas pendentes demais ou o serviço está indisponível.', 'unavailable')
  const result = await authority.client.from('integration_connection_proposals').insert({ id: randomUUID(), user_id: authority.ownerId, project_id: authority.projectId,
    input, input_hash: hash(input), expires_at: new Date(Date.now() + 24 * 3600000).toISOString() }).select(columns).single()
  if (result.error) throw new IntegrationError('Não foi possível preparar a autorização. Confira a migration 037.', 'unavailable')
  return view(result.data)
}
export async function listIntegrationConnectionProposals(authority: IntegrationAuthority): Promise<ConnectionProposal[]> {
  await verifyIntegrationOwner(authority)
  const result = await authority.client.from('integration_connection_proposals').select(columns).eq('user_id', authority.ownerId).eq('project_id', authority.projectId).order('created_at', { ascending: false }).limit(100)
  if (result.error) throw new IntegrationError('Propostas indisponíveis.', 'unavailable')
  return (result.data ?? []).map(view)
}
/** This extra authority is always the authenticated owner session, not the
 * device identity which can prepare proposals. Agent proposals grant nothing. */
export interface ProposalApprovalAuthority extends IntegrationAuthority { verifyOwnerSession(): Promise<string> }
export async function approveIntegrationConnectionProposal(authority: ProposalApprovalAuthority, raw: { proposalId: string; credentialId: string }) {
  const input = z.object({ proposalId: z.uuid(), credentialId: z.uuid() }).strict().parse(raw)
  await verifyIntegrationOwner(authority)
  if (await authority.verifyOwnerSession() !== authority.ownerId) throw new IntegrationError('Autorização exige a sessão do dono.', 'forbidden')
  const scoped = () => authority.client.from('integration_connection_proposals').select(columns).eq('id', input.proposalId).eq('user_id', authority.ownerId).eq('project_id', authority.projectId)
  const found = await scoped().maybeSingle()
  if (found.error || !found.data) throw new IntegrationError('Proposta não encontrada.', 'forbidden')
  const proposal = view(found.data)
  if (proposal.input.oauth) throw new IntegrationError('Esta proposta exige consentimento OAuth, não uma chave.', 'forbidden')
  if (proposal.status === 'approved' && proposal.connectionId) return readProviderConnection(authority, proposal.connectionId)
  if (proposal.status !== 'pending' || Date.parse(proposal.expiresAt) <= Date.now()) throw new IntegrationError('Proposta expirada ou encerrada. Prepare uma nova proposta.')
  if (proposal.input.credentialId && proposal.input.credentialId !== input.credentialId) throw new IntegrationError('A credencial difere da proposta exibida. Prepare uma nova proposta.', 'forbidden')
  const token = randomUUID(), now = new Date().toISOString()
  const claimed = await authority.client.from('integration_connection_proposals').update({ claim_token: token, claim_expires_at: new Date(Date.now() + 120000).toISOString() }).eq('id', proposal.id).eq('user_id', authority.ownerId).eq('project_id', authority.projectId).eq('status', 'pending').gt('expires_at', now).or(`claim_token.is.null,claim_expires_at.lt.${now}`).select('id').maybeSingle()
  if (claimed.error || !claimed.data) throw new IntegrationError('Outra autorização está em andamento; atualize o estado.', 'unavailable')
  // Every remote read verifies the owner session and reservation again. Creating
  // a connection only checks identity; it never configures a provider resource.
  const verifyIdentity = async () => {
    if (await authority.verifyOwnerSession() !== authority.ownerId) throw new IntegrationError('Sessão de autorização mudou.', 'forbidden')
    const held = await scoped().eq('claim_token', token).gt('claim_expires_at', new Date().toISOString()).eq('status', 'pending').maybeSingle()
    if (held.error || !held.data || hash(view(held.data).input) !== hash(proposal.input)) throw new IntegrationError('A proposta ou sua reserva mudou.', 'forbidden')
    return authority.verifyIdentity()
  }
  const connection = await createProviderConnection({ ...authority, verifyIdentity }, integrationConnectionInputSchema.parse({ ...proposal.input, credentialId: input.credentialId }))
  await verifyIdentity()
  const saved = await authority.client.from('integration_connection_proposals').update({ status: 'approved', connection_id: connection.id, claim_token: null, claim_expires_at: null }).eq('id', proposal.id).eq('user_id', authority.ownerId).eq('project_id', authority.projectId).eq('claim_token', token).eq('status', 'pending').select('id').maybeSingle()
  if (saved.error || !saved.data) throw new IntegrationError('Conexão salva, mas a conclusão da proposta não foi registrada. Consulte as conexões antes de autorizar de novo.', 'outcome_unknown')
  return connection
}
async function ownerPendingProposal(authority: ProposalApprovalAuthority, proposalId: string) {
  z.uuid().parse(proposalId)
  await verifyIntegrationOwner(authority)
  if (await authority.verifyOwnerSession() !== authority.ownerId) throw new IntegrationError('Autorização exige a sessão do dono.', 'forbidden')
  const result = await authority.client.from('integration_connection_proposals').select(columns).eq('id', proposalId).eq('user_id', authority.ownerId).eq('project_id', authority.projectId).eq('status', 'pending').gt('expires_at', new Date().toISOString()).maybeSingle()
  if (result.error || !result.data) throw new IntegrationError('Proposta expirada, encerrada ou indisponível.', 'forbidden')
  return view(result.data)
}
export async function approveIntegrationProposalWithKey(authority: ProposalApprovalAuthority, proposalId: string, rawValue: string) {
  const value = z.string().min(1).max(16384).refine(value => !/[\r\n\u0000]/.test(value)).parse(rawValue)
  const proposal = await ownerPendingProposal(authority, proposalId)
  if (proposal.input.credentialId || proposal.input.oauth) throw new IntegrationError('Use a credencial ou o consentimento indicado na proposta.', 'forbidden')
  await authorizeProjectOperation({ ...authority, environment: proposal.input.environment }, 'integrations.configure')
  const store = credentialStore(authority.client, authority.ownerId, authority.projectId)
  const scope = { id: proposal.id, userId: authority.ownerId, projectId: authority.projectId, environment: proposal.input.environment }
  await store.authorize()
  const previous = await store.find(proposal.id)
  if (previous) {
    if (previous.environment !== scope.environment || decryptCredential(previous.encryptedValue, scope) !== value) throw new IntegrationError('A proposta já guardou outra chave. Use o cofre ou prepare uma nova proposta.', 'forbidden')
  } else {
    await store.audit('saved', proposal.id)
    const time = new Date().toISOString()
    await store.insert({ ...scope, name: `INTEGRATION_${proposal.input.provider.replaceAll('-', '_').toUpperCase()}`, encryptedValue: encryptCredential(value, scope), createdAt: time, updatedAt: time })
  }
  return approveIntegrationConnectionProposal(authority, { proposalId, credentialId: proposal.id })
}
export async function approveOAuthIntegrationConnectionProposal(authority: ProposalApprovalAuthority, proposalId: string) {
  const proposal = await ownerPendingProposal(authority, proposalId)
  if (!proposal.input.oauth) throw new IntegrationError('Proposta não usa consentimento OAuth.', 'forbidden')
  const result = await beginOAuthConnection(authority, proposal.input.oauth)
  const saved = await authority.client.from('integration_connection_proposals').update({ status: 'approved' }).eq('id', proposal.id).eq('user_id', authority.ownerId).eq('project_id', authority.projectId).eq('status', 'pending').select('id').maybeSingle()
  if (saved.error || !saved.data) throw new IntegrationError('Início do consentimento não foi registrado. Atualize o estado.', 'unavailable')
  return result
}
