'use server'

import { z } from 'zod'
import { requireProjectOwner, requireUser } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/admin'
import { createProviderConnection, listProviderConnections, revokeProviderConnection } from '@/lib/provider-connections/server'
import { integrationConnectionInputSchema, integrationOptionsSchema, IntegrationError, type IntegrationConnectionInput } from '@/lib/integrations/contract'
import { listIntegrationSessions, runAuthorizedIntegration } from '@/lib/integrations/server'
import { listIntegrationConnectionProposals, approveIntegrationConnectionProposal, approveIntegrationProposalWithKey, approveOAuthIntegrationConnectionProposal } from '@/lib/provider-connections/proposals'

async function authority(projectId: string) {
  const { user } = await requireProjectOwner(z.uuid().parse(projectId), 'id,user_id')
  return { client: createServiceClient(), ownerId: user.id, projectId, ownerSession: true as const, verifyIdentity: async () => (await requireUser()).user.id }
}
const message = (error: unknown) => error instanceof IntegrationError ? error.message : 'Operação de integração não confirmada. Confira a autorização, os campos e o estado do pedido.'
export async function connectIntegration(raw: IntegrationConnectionInput) {
  try { const input = integrationConnectionInputSchema.parse(raw); return { ok: true as const, connection: await createProviderConnection(await authority(input.projectId), input) } }
  catch (error) { return { ok: false as const, error: message(error) } }
}
export async function getIntegrations(projectId: string) {
  try { const auth = await authority(projectId); return { ok: true as const, connections: await listProviderConnections(auth), sessions: await listIntegrationSessions(auth), proposals: await listIntegrationConnectionProposals(auth) } }
  catch (error) { return { ok: false as const, error: message(error) } }
}
export async function executeIntegration(raw: { projectId: string; options: unknown }) {
  try { const input = z.object({ projectId: z.uuid(), options: integrationOptionsSchema }).strict().parse(raw); return { ok: true as const, receipt: await runAuthorizedIntegration(await authority(input.projectId), input.options) } }
  catch (error) { return { ok: false as const, error: message(error) } }
}
export async function disconnectIntegration(raw: { projectId: string; connectionId: string }) {
  try { const input = z.object({ projectId: z.uuid(), connectionId: z.uuid() }).strict().parse(raw); await revokeProviderConnection(await authority(input.projectId), input.connectionId); return { ok: true as const } }
  catch (error) { return { ok: false as const, error: message(error) } }
}
export async function approveIntegrationProposal(raw: { projectId: string; proposalId: string; credentialId: string }) {
  try {
    const input = z.object({ projectId: z.uuid(), proposalId: z.uuid(), credentialId: z.uuid() }).strict().parse(raw)
    const auth = await authority(input.projectId)
    return { ok: true as const, connection: await approveIntegrationConnectionProposal({ ...auth, verifyOwnerSession: async () => (await requireUser()).user.id }, { proposalId: input.proposalId, credentialId: input.credentialId }) }
  } catch (error) { return { ok: false as const, error: message(error) } }
}
export async function approveIntegrationWithKey(raw: { projectId: string; proposalId: string; value: string }) {
  try {
    const input = z.object({ projectId: z.uuid(), proposalId: z.uuid(), value: z.string().min(1).max(16384) }).strict().parse(raw)
    const auth = await authority(input.projectId)
    return { ok: true as const, connection: await approveIntegrationProposalWithKey({ ...auth, verifyOwnerSession: async () => (await requireUser()).user.id }, input.proposalId, input.value) }
  } catch (error) { return { ok: false as const, error: message(error) } }
}
export async function approveOAuthIntegrationProposal(raw: { projectId: string; proposalId: string }) {
  try {
    const input = z.object({ projectId: z.uuid(), proposalId: z.uuid() }).strict().parse(raw)
    const auth = await authority(input.projectId)
    return { ok: true as const, ...await approveOAuthIntegrationConnectionProposal({ ...auth, verifyOwnerSession: async () => (await requireUser()).user.id }, input.proposalId) }
  } catch (error) { return { ok: false as const, error: message(error) } }
}
