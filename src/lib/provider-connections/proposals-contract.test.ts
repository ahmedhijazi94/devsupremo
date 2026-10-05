import { describe, expect, it } from 'vitest'
import { connectionProposalInputSchema } from './proposals-contract'
const input = { projectId: '11111111-1111-4111-8111-111111111111', provider: 'resend', environment: 'development', allowedSenders: ['sender@example.com'], allowedRecipients: ['recipient@example.com'] }
describe('connection proposal is data, never an approval', () => {
  it('prepares a complete destination without a credential and rejects embedded secrets or client approval', () => {
    expect(connectionProposalInputSchema.parse(input).credentialId).toBeUndefined()
    for (const extra of [{ value: 'private' }, { approved: true }, { ownerId: input.projectId }, { credentialId: 'private-key' }, { environment: 'production', provider: 'stripe-test', allowedSenders: [], allowedRecipients: [] }]) expect(connectionProposalInputSchema.safeParse({ ...input, ...extra }).success).toBe(false)
  })
  it('requires an approved custom connector and exact OAuth account/destination binding', () => {
    const connector = { version: 1, origin: 'https://api.example.com', authorization: 'bearer', identity: { path: '/account', field: 'id', account: 'acct-1' }, operations: [{ name: 'read', path: '/settings', method: 'GET', inputs: [], output: ['name'] }] }
    const oauth = { version: 1, providerKey: 'example', environment: 'development', clientId: 'app-client', clientAuthentication: 'none', authorization: { origin: 'https://auth.example.com', path: '/authorize' }, token: { origin: 'https://auth.example.com', path: '/token' }, scopes: ['profile'], connector }
    const proposal = { projectId: input.projectId, provider: 'generic', environment: 'development', contract: connector, oauth }
    expect(connectionProposalInputSchema.safeParse(proposal).success).toBe(true)
    for (const patch of [{ credentialId: input.projectId }, { environment: 'production' }, { contract: { ...connector, origin: 'https://different.example.com' } }]) expect(connectionProposalInputSchema.safeParse({ ...proposal, ...patch }).success).toBe(false)
  })
})
