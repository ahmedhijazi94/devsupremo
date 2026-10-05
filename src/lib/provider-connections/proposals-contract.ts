import { z } from 'zod'
import { integrationConnectionInputSchema } from '../integrations/contract'
import { oauthConfigurationSchema } from './oauth-contract'
export const connectionProposalInputSchema = z.object({ ...integrationConnectionInputSchema.shape, credentialId: z.uuid().optional(), oauth: oauthConfigurationSchema.optional() }).strict().superRefine((value, context) => {
  const { oauth, ...connection } = value
  const parsed = integrationConnectionInputSchema.safeParse({ ...connection, credentialId: value.credentialId ?? '00000000-0000-4000-8000-000000000001' })
  if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: 'custom', message: issue.message, path: issue.path })
  if (oauth && (value.provider !== 'generic' || value.credentialId || value.environment !== oauth.environment || JSON.stringify(value.contract) !== JSON.stringify(oauth.connector))) context.addIssue({ code: 'custom', message: 'OAuth deve corresponder ao destino e contrato da proposta.' })
  if (JSON.stringify(value).length > 20000) context.addIssue({ code: 'custom', message: 'Proposta excede o limite.' })
})
export type ConnectionProposalInput = z.infer<typeof connectionProposalInputSchema>
export const connectionProposalSchema = z.object({ id: z.uuid(), input: connectionProposalInputSchema,
  status: z.enum(['pending', 'approved', 'rejected']), connectionId: z.uuid().nullable(), createdAt: z.string(), expiresAt: z.string(), authorizationPath: z.string() })
export type ConnectionProposal = z.infer<typeof connectionProposalSchema>
