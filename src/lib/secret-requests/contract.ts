import { z } from 'zod'

export const secretTargetSchema = z.enum(['supabase', 'vercel'])
export const secretEnvironmentSchema = z.enum(['development', 'preview', 'production'])
export const secretNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/)
  .refine((name) => !/^(NEXT_PUBLIC_|PUBLIC_|VITE_|REACT_APP_|NUXT_PUBLIC_)/.test(name), 'Secrets não podem ser públicos.')
  .refine((name) => !/^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|PATH|HOME|SHELL)$/.test(name), 'Nome reservado ao ambiente.')
export const secretEntrySchema = z.object({
  name: secretNameSchema,
  description: z.string().trim().min(1).max(1000),
  target: secretTargetSchema,
  environment: secretEnvironmentSchema,
}).strict().refine((entry) => entry.target !== 'supabase' || (entry.environment !== 'preview' && !entry.name.startsWith('SUPABASE_')), 'Destino ou nome reservado do Supabase.')
