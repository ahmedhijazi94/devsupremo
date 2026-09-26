import { z } from 'zod'

const fingerprintSchema = z.string().length(64).regex(/^[a-fA-F0-9]+$/)
const metadataSchema = z.array(z.object({
  name: z.string().min(1).max(128),
  value: fingerprintSchema,
  // Never let an unexpected alias disagree with the documented fingerprint.
  digest: fingerprintSchema.optional(),
  updated_at: z.string().max(256).optional(),
})).max(1000)

export interface SupabaseSecretMetadata {
  name: string
  digest: string
}

/** GET /v1/projects/{ref}/secrets returns a fingerprint in `value`, not the
 * secret passed to POST. The official CLI labels this field DIGEST:
 * https://github.com/supabase/cli/blob/b8026df5ea50d49bc06dcfa8ab877e5f92c032a9/apps/cli/src/commands/secrets/secrets.format.ts
 * The official Dashboard identifies the algorithm as SHA256:
 * https://github.com/supabase/supabase/blob/36371de15127206280d2d40786e8578dfe1b681a/apps/studio/components/interfaces/Functions/EdgeFunctionSecrets/EdgeFunctionSecrets.tsx#L96
 * Parse only this response contract; never hash an unrecognized response value
 * as a fallback, return provider payloads, or surface Zod's input diagnostics.
 */
export function parseSupabaseSecretMetadata(raw: unknown): SupabaseSecretMetadata[] | null {
  const parsed = metadataSchema.safeParse(raw)
  if (!parsed.success) return null
  const names = new Set<string>()
  const result: SupabaseSecretMetadata[] = []
  for (const item of parsed.data) {
    const digest = item.value.toLowerCase()
    if (names.has(item.name) || (item.digest !== undefined && item.digest.toLowerCase() !== digest)) return null
    names.add(item.name)
    result.push({ name: item.name, digest })
  }
  return result
}
