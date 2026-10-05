import { z } from 'zod'
import { genericConnectorSchema, genericScalarSchema } from './generic-contract'
export { IntegrationError } from './error'

export const integrationProviderSchema = z.enum(['resend', 'stripe-test', 'github', 'generic'])
export const integrationEnvironmentSchema = z.enum(['development', 'production'])
const email = z.email().max(254).transform(value => value.toLowerCase())
export const repositoryNameSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/)
export const integrationConnectionInputSchema = z.object({
  projectId: z.uuid(), credentialId: z.uuid(), provider: integrationProviderSchema,
  environment: integrationEnvironmentSchema,
  allowedSenders: z.array(email).max(5).default([]), allowedRecipients: z.array(email).max(10).default([]),
  allowedRepositories: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/)).max(10).default([]),
  contract: genericConnectorSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.provider === 'stripe-test' && value.environment !== 'development') context.addIssue({ code: 'custom', message: 'Pagamentos deste conector são somente sandbox.' })
  if (value.provider !== 'resend' && (value.allowedSenders.length || value.allowedRecipients.length)) context.addIssue({ code: 'custom', message: 'Remetentes e destinatários pertencem somente ao conector de email.' })
  if (value.provider !== 'github' && value.allowedRepositories.length) context.addIssue({ code: 'custom', message: 'Repositórios pertencem somente ao conector GitHub.' })
  if ((value.provider === 'generic') !== Boolean(value.contract)) context.addIssue({ code: 'custom', message: 'API personalizada exige contrato aprovado do dono.' })
})
export type IntegrationConnectionInput = z.infer<typeof integrationConnectionInputSchema>
export const integrationConnectionSchema = z.object({ ...integrationConnectionInputSchema.shape,
  id: z.uuid(), ownerId: z.uuid(), credentialId: z.uuid().nullable(), accountRef: z.string().min(1).max(160), accountIdentityVerified: z.boolean(),
  revokedAt: z.iso.datetime().nullable(), createdAt: z.iso.datetime(),
  oauth: z.boolean().optional(),
}).strict()
export type IntegrationConnection = z.infer<typeof integrationConnectionSchema>
const target = { connectionId: z.uuid(), operationId: z.uuid() }
export const integrationOptionsSchema = z.discriminatedUnion('operation', [
  z.object({ ...target, operation: z.literal('resend-send-test'), from: email, to: email }).strict(),
  z.object({ ...target, operation: z.literal('stripe-create-test-product'), name: z.string().trim().min(1).max(100) }).strict(),
  z.object({ ...target, operation: z.literal('github-repository'), owner: repositoryNameSchema, repository: repositoryNameSchema }).strict(),
  z.object({ ...target, operation: z.literal('generic-call'), name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), input: z.record(z.string(), genericScalarSchema).refine(value => Object.keys(value).length <= 16).default({}) }).strict(),
])
export type IntegrationOptions = z.infer<typeof integrationOptionsSchema>
export const integrationReceiptSchema = z.object({
  operationId: z.uuid(), connectionId: z.uuid(), operation: z.enum(['resend-send-test', 'stripe-create-test-product', 'github-repository', 'generic-call']),
  status: z.enum(['running', 'verifying', 'completed', 'outcome_unknown', 'failed']),
  resourceId: z.string().max(200).nullable(), effectVerified: z.boolean(),
  evidence: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])),
  observedAt: z.iso.datetime(), valuesReceived: z.literal(false),
})
export type IntegrationReceipt = z.infer<typeof integrationReceiptSchema>
export const INTEGRATION_CATALOG = [
  { provider: 'resend', operations: ['resend-send-test'], authentication: 'vault_api_key', accountIdentity: 'credential_scope', effect: 'provider_delivery_event', limits: 'Somente mensagem fixa aos remetentes e destinatários autorizados; entrega pode ficar pendente.' },
  { provider: 'stripe-test', operations: ['stripe-create-test-product'], authentication: 'vault_test_key', accountIdentity: 'provider_account', effect: 'resource_readback', limits: 'Somente produto sandbox; não cobra, cria assinatura ou configura webhooks.' },
  { provider: 'github', operations: ['github-repository'], authentication: 'vault_token', accountIdentity: 'provider_user', effect: 'resource_readback', limits: 'Consulta metadados de repositórios explicitamente autorizados; não retorna conteúdo de arquivos.' },
  { provider: 'generic', operations: ['generic-call'], authentication: 'vault_api_key', accountIdentity: 'approved_identity_endpoint', effect: 'approved_readback', limits: 'Contrato aprovado pelo dono, destinos e campos fixos. Mutação sem ID ou resultado observado não é repetida automaticamente.' },
] as const
