import { z } from 'zod'
import { connectorOriginSchema, genericConnectorSchema } from '../integrations/generic-contract'

const endpoint = z.object({ origin: connectorOriginSchema, path: z.string().max(300).regex(/^\/[A-Za-z0-9/_-]*$/).refine(value => !value.includes('//')) }).strict()
export const oauthConfigurationSchema = z.object({
  version: z.literal(1), environment: z.enum(['development', 'production']),
  providerKey: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  authorization: endpoint, token: endpoint, issuer: connectorOriginSchema.optional(),
  clientId: z.string().min(1).max(300).regex(/^[^\u0000-\u0020\u007f]+$/),
  clientAuthentication: z.enum(['none', 'client_secret_post', 'client_secret_basic']),
  clientSecretId: z.uuid().optional(),
  scopes: z.array(z.string().min(1).max(120).regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/)).min(1).max(30),
  connector: genericConnectorSchema.refine(value => value.authorization === 'bearer', 'OAuth exige Bearer.'),
}).strict().superRefine((value, context) => {
  if ((value.clientAuthentication !== 'none') !== Boolean(value.clientSecretId)) context.addIssue({ code: 'custom', message: 'Credencial do cliente incompatível com autenticação OAuth.' })
  if (new Set(value.scopes).size !== value.scopes.length) context.addIssue({ code: 'custom', message: 'Escopos duplicados.' })
})
export type OAuthConfiguration = z.infer<typeof oauthConfigurationSchema>
export const oauthCallbackSchema = z.object({ state: z.string().regex(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/), code: z.string().min(1).max(4000).regex(/^[^\u0000-\u0020\u007f]+$/), issuer: connectorOriginSchema.optional() }).strict()
export type OAuthCallback = z.infer<typeof oauthCallbackSchema>
export const oauthTokensSchema = z.object({ accessToken: z.string().min(1).max(6000), refreshToken: z.string().min(1).max(6000).nullable(), expiresAt: z.number().finite().nullable(), scopes: z.array(z.string()) }).strict()
export type OAuthTokens = z.infer<typeof oauthTokensSchema>
export class OAuthError extends Error {
  constructor(message: string, readonly status = 409) { super(message); this.name = 'OAuthError' }
}
/** The prefix locates a project; it never authorizes that project. */
export function oauthCallbackProjectId(state: string): string {
  return z.uuid().parse(oauthCallbackSchema.shape.state.parse(state).split('.')[0])
}
