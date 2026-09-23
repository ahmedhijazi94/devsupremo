import { z } from 'zod'

export const secretTargetSchema = z.enum(['supabase', 'vercel'])
export const secretEnvironmentSchema = z.enum(['development', 'preview', 'production'])
/** Setup intent is metadata only. Credentials arrive exclusively through the owner form. */
export const secretConfigurationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('supabase-smtp'), provider: z.literal('resend'),
    senderEmail: z.string().email().max(254),
    senderName: z.string().trim().min(1).max(100).refine((value) => !/[\r\n\0]/.test(value), 'Nome do remetente inválido.'),
  }).strict(),
  z.object({ kind: z.literal('supabase-user-password'), userId: z.string().uuid() }).strict(),
])
export const secretNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/)
  .refine((name) => !/^(NEXT_PUBLIC_|PUBLIC_|VITE_|REACT_APP_|NUXT_PUBLIC_)/.test(name), 'Secrets não podem ser públicos.')
  .refine((name) => !/^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|PATH|HOME|SHELL)$/.test(name), 'Nome reservado ao ambiente.')
export const secretEntrySchema = z.object({
  name: secretNameSchema,
  description: z.string().trim().min(1).max(1000),
  target: secretTargetSchema,
  environment: secretEnvironmentSchema,
  configuration: secretConfigurationSchema.optional(),
}).strict()
  .refine((entry) => entry.target !== 'supabase' || (entry.environment !== 'preview' && !entry.name.startsWith('SUPABASE_')), 'Destino ou nome reservado do Supabase.')
  .refine((entry) => !entry.configuration || entry.target === 'supabase', 'Esta configuração exige o destino Supabase.')
  .refine((entry) => entry.configuration?.kind !== 'supabase-user-password' || entry.environment === 'development', 'Definir senha por este formulário é permitido somente no ambiente de desenvolvimento.')
