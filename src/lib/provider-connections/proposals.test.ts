import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptCredential } from '../credentials/crypto'
import type { CredentialRecord } from '../credentials/service'
import { connectionProposalInputSchema } from './proposals-contract'
const mocks = vi.hoisted(() => ({ owner: vi.fn(), policy: vi.fn(), create: vi.fn(), read: vi.fn(), begin: vi.fn(), findCredential: vi.fn(), insertCredential: vi.fn(), audit: vi.fn() }))
vi.mock('./server', () => ({ verifyIntegrationOwner: mocks.owner, createProviderConnection: mocks.create, readProviderConnection: mocks.read }))
vi.mock('../backend-operations/server', () => ({ authorizeProjectOperation: mocks.policy }))
vi.mock('./oauth-server', () => ({ beginOAuthConnection: mocks.begin }))
vi.mock('../credentials/store', () => ({ credentialStore: () => ({ authorize: mocks.owner, find: mocks.findCredential, insert: mocks.insertCredential, audit: mocks.audit }) }))
import { approveIntegrationConnectionProposal, approveIntegrationProposalWithKey, listIntegrationConnectionProposals, proposeIntegrationConnection } from './proposals'

const owner = '11111111-1111-4111-8111-111111111111', project = '22222222-2222-4222-8222-222222222222', id = '33333333-3333-4333-8333-333333333333', credential = '44444444-4444-4444-8444-444444444444', connection = '55555555-5555-4555-8555-555555555555'
const input = connectionProposalInputSchema.parse({ projectId: project, provider: 'resend', environment: 'development', allowedSenders: ['from@example.com'], allowedRecipients: ['to@example.com'] })
let row: Record<string, unknown> | null, blocked: boolean
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const resetRow = () => ({ id, user_id: owner, project_id: project, input, input_hash: digest(input), status: 'pending', connection_id: null, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), claim_token: null, claim_expires_at: null })
class Query {
  filters: [string, unknown][] = []
  patch: Record<string, unknown> | null = null
  many = false; count = false; claiming = false
  eq(name: string, value: unknown) { this.filters.push([name, value]); return this }
  gt(name: string, value: string) { this.filters.push([`gt:${name}`, value]); return this }
  or() { this.claiming = true; return this }
  select(_fields?: string, options?: { count?: string; head?: boolean }) { this.count = Boolean(options?.count); return this }
  update(value: Record<string, unknown>) { this.patch = value; return this }
  insert(value: Record<string, unknown>) { row = { ...resetRow(), ...value }; return this }
  order() { this.many = true; return this }
  limit() { return this }
  execute() {
    const found = row && this.filters.every(([name, value]) => name.startsWith('gt:') ? String(row![name.slice(3)]) > String(value) : row![name] === value) && (!this.claiming || !blocked)
    if (found && this.patch) Object.assign(row!, this.patch)
    return { data: this.many ? found ? [row] : [] : found ? structuredClone(row) : null, error: null, count: this.count ? Number(Boolean(found)) : null }
  }
  maybeSingle() { return Promise.resolve(this.execute()) }
  single() { return this.maybeSingle() }
  then: Promise<ReturnType<Query['execute']>>['then'] = (fulfilled, rejected) => Promise.resolve(this.execute()).then(fulfilled, rejected)
}
function authority() { return { client: { from: () => new Query() } as unknown as SupabaseClient, ownerId: owner, projectId: project, verifyIdentity: vi.fn(async () => owner), verifyOwnerSession: vi.fn(async () => owner) } }
beforeEach(() => {
  vi.resetAllMocks(); row = resetRow(); blocked = false
  mocks.create.mockImplementation(async (auth: ReturnType<typeof authority>) => { await auth.verifyIdentity(); return { id: connection } })
  mocks.read.mockResolvedValue({ id: connection }); mocks.findCredential.mockResolvedValue(null)
})
describe('owner-approved immutable connection proposals', () => {
  it('lets a device prepare and list metadata, but does not configure a provider', async () => {
    const proposal = await proposeIntegrationConnection(authority(), input)
    expect(proposal.input).toEqual(input)
    expect(proposal.authorizationPath).toContain(`/projects/${project}/backend?section=integrations&integrationProposal=`)
    expect(mocks.policy).toHaveBeenCalledWith(expect.objectContaining({ environment: 'development' }), 'integrations.read')
    expect(mocks.create).not.toHaveBeenCalled()
    expect(await listIntegrationConnectionProposals(authority())).toHaveLength(1)
    await expect(proposeIntegrationConnection({ ...authority(), projectId: owner }, input)).rejects.toThrow('fora do projeto')
  })
  it('requires independent owner session and detects altered or expired proposal', async () => {
    const auth = authority(); auth.verifyOwnerSession.mockResolvedValue(project)
    await expect(approveIntegrationConnectionProposal(auth, { proposalId: id, credentialId: credential })).rejects.toThrow('sessão do dono')
    row!.input_hash = 'tampered'
    await expect(approveIntegrationConnectionProposal(authority(), { proposalId: id, credentialId: credential })).rejects.toThrow('proposta mudou')
    row = { ...resetRow(), expires_at: '2000-01-01T00:00:00Z' }
    await expect(approveIntegrationConnectionProposal(authority(), { proposalId: id, credentialId: credential })).rejects.toThrow('expirada')
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('approves exact prepared scope once and returns the existing connection on replay', async () => {
    expect(await approveIntegrationConnectionProposal(authority(), { proposalId: id, credentialId: credential })).toEqual({ id: connection })
    expect(mocks.create).toHaveBeenCalledWith(expect.anything(), { ...input, credentialId: credential })
    expect(row).toMatchObject({ status: 'approved', connection_id: connection })
    expect(await approveIntegrationConnectionProposal(authority(), { proposalId: id, credentialId: credential })).toEqual({ id: connection })
    expect(mocks.create).toHaveBeenCalledOnce()
  })
  it('refuses an altered credential choice and an active concurrent approval', async () => {
    const bound = connectionProposalInputSchema.parse({ ...input, credentialId: credential }); row = { ...resetRow(), input: bound, input_hash: digest(bound) }
    await expect(approveIntegrationConnectionProposal(authority(), { proposalId: id, credentialId: owner })).rejects.toThrow('credencial difere')
    row = resetRow(); blocked = true
    await expect(approveIntegrationConnectionProposal(authority(), { proposalId: id, credentialId: credential })).rejects.toThrow('Outra autorização')
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('stores a newly entered key encrypted in exact project scope and exposes only the connection', async () => {
    const result = await approveIntegrationProposalWithKey(authority(), id, 'private-fixture-key')
    expect(result).toEqual({ id: connection })
    const record = mocks.insertCredential.mock.calls[0]![0] as CredentialRecord
    expect(record.encryptedValue).not.toContain('private-fixture-key')
    expect(decryptCredential(record.encryptedValue, { id, userId: owner, projectId: project, environment: 'development' })).toBe('private-fixture-key')
    expect(record.name).toBe('INTEGRATION_RESEND')
    row = resetRow(); mocks.findCredential.mockResolvedValue(record)
    await expect(approveIntegrationProposalWithKey(authority(), id, 'different-key')).rejects.toThrow('outra chave')
    expect(mocks.insertCredential).toHaveBeenCalledOnce()
  })
})
