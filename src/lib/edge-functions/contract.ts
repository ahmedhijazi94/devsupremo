import { z } from 'zod'

export const FUNCTION_MAX_FILES = 64
export const FUNCTION_FILE_BYTES = 128 * 1024
export const FUNCTION_BUNDLE_BYTES = 512 * 1024
export const FUNCTION_REQUEST_BYTES = 3_300_000
export const FUNCTION_HOOK_SECRET_NAME = 'AUTH_SEND_EMAIL_HOOK_SECRET'
export const functionOperationSchema = z.enum(['functions-list', 'functions-status', 'functions-deploy', 'functions-hook-status', 'functions-hook-configure'])
export const functionSlugSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*(?![\s\S])/)
export const functionPathSchema = z.string().max(240).refine(path => {
  if (!/^(src\/|supabase\/functions\/)/.test(path) || !/\.(ts|js|json)$/.test(path) || /[\s\\]/.test(path)) return false
  return path.split('/').every(part => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part)
    && !/^(?:node_modules|env(?:\.|$)|credentials(?:\.|$)|private[-_]key(?:\.|$))/i.test(part))
}, 'Arquivo deve ser código explícito em src/ ou supabase/functions/, sem caminhos ocultos ou credenciais.')
const sourceSchema = z.string().max(FUNCTION_FILE_BYTES).refine(content => {
  const bytes = new TextEncoder().encode(content)
  return bytes.length <= FUNCTION_FILE_BYTES && !content.includes('\0') && new TextDecoder().decode(bytes) === content
}, 'Arquivo deve ser UTF-8 e ter no máximo 128 KiB.')
export const functionEnvironmentSchema = z.enum(['development', 'production'])
const environment = functionEnvironmentSchema
const deployFields = {
  slug: functionSlugSchema, environment,
  entrypoint: functionPathSchema,
  importMap: functionPathSchema.optional(),
  files: z.array(z.object({ path: functionPathSchema, content: sourceSchema }).strict()).min(1).max(FUNCTION_MAX_FILES),
  verifyJwt: z.boolean().default(true),
}
function validBundle(value: { slug: string; entrypoint: string; importMap?: string | undefined; files: { path: string; content: string }[] }): boolean {
  const paths = value.files.map(file => file.path)
  return value.entrypoint.startsWith(`supabase/functions/${value.slug}/`) && /\.(ts|js)$/.test(value.entrypoint)
    && paths.includes(value.entrypoint) && (!value.importMap || value.importMap.endsWith('.json') && paths.includes(value.importMap))
    && new Set(paths.map(path => path.toLowerCase())).size === paths.length
    && value.files.reduce((size, file) => size + new TextEncoder().encode(file.content).length, 0) <= FUNCTION_BUNDLE_BYTES
}
export const functionDeploySchema = z.object(deployFields).strict().refine(validBundle, 'Bundle inválido: confira entrada, import map, duplicatas e limite de 512 KiB.')
const variants = [
  z.object({ operation: z.literal('functions-list'), environment }).strict(),
  z.object({ operation: z.literal('functions-status'), environment, slug: functionSlugSchema }).strict(),
  z.object({ operation: z.literal('functions-deploy'), ...deployFields }).strict(),
  z.object({ operation: z.literal('functions-hook-status'), environment }).strict(),
  z.object({ operation: z.literal('functions-hook-configure'), environment, slug: functionSlugSchema,
    secretName: z.literal(FUNCTION_HOOK_SECRET_NAME).default(FUNCTION_HOOK_SECRET_NAME) }).strict(),
] as const
export const functionOptionsSchema = z.discriminatedUnion('operation', variants).refine(value => value.operation !== 'functions-deploy' || validBundle(value), 'Bundle inválido.')
const authority = { deviceSecret: z.string().min(10).max(256), projectId: z.string().uuid(), expectedRef: z.string().regex(/^[a-z0-9_-]+(?![\s\S])/).max(64) }
export const functionRequestSchema = z.discriminatedUnion('operation', [
  variants[0].extend(authority), variants[1].extend(authority), variants[2].extend(authority), variants[3].extend(authority), variants[4].extend(authority),
]).refine(value => value.operation !== 'functions-deploy' || validBundle(value), 'Bundle inválido.')
export type FunctionDeploy = z.infer<typeof functionDeploySchema>
export type FunctionOptions = z.infer<typeof functionOptionsSchema>
export type FunctionRequest = z.infer<typeof functionRequestSchema>
export const isFunctionRead = (operation: string): boolean => ['functions-list', 'functions-status', 'functions-hook-status'].includes(operation)

export const functionViewSchema = z.object({ slug: functionSlugSchema, status: z.enum(['ACTIVE', 'REMOVED', 'THROTTLED']), version: z.number().int().nonnegative(), verifyJwt: z.boolean().nullable() })
export const functionHookViewSchema = z.object({ enabled: z.boolean(), targetSlug: functionSlugSchema.nullable(), targetMatchesProject: z.boolean(), signingSecretConfigured: z.boolean() })
const responseFields = { projectId: z.string().uuid(), projectRef: authority.expectedRef, environment,
  observedAt: z.iso.datetime(), execution: z.literal('server_api'), providerDashboardRequired: z.literal(false), valuesReceived: z.literal(false) }
export const functionResponseSchema = z.discriminatedUnion('operation', [
  z.object({ ...responseFields, operation: z.literal('functions-list'), readOnly: z.literal(true), data: z.object({ functions: z.array(functionViewSchema).max(1000) }) }),
  z.object({ ...responseFields, operation: z.literal('functions-status'), readOnly: z.literal(true), data: z.object({ function: functionViewSchema.nullable() }) }),
  z.object({ ...responseFields, operation: z.literal('functions-deploy'), readOnly: z.literal(false), data: z.object({ function: functionViewSchema, deployed: z.literal(true), verified: z.literal(true), deliveryVerified: z.literal(false) }) }),
  z.object({ ...responseFields, operation: z.literal('functions-hook-status'), readOnly: z.literal(true), data: z.object({ hook: functionHookViewSchema, deliveryVerified: z.literal(false) }) }),
  z.object({ ...responseFields, operation: z.literal('functions-hook-configure'), readOnly: z.literal(false), data: z.object({ hook: functionHookViewSchema, configured: z.literal(true), verified: z.literal(true), signatureVerified: z.literal(true), deliveryVerified: z.literal(false) }) }),
])
export type FunctionResponse = z.infer<typeof functionResponseSchema>
