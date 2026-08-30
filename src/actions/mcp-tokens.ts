'use server'

import { createClient } from '@/lib/supabase/server'
import { generateMcpToken } from '@/lib/mcp/tokens'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

/**
 * Gestão dos tokens de MCP do usuário.
 *
 * O valor em claro é devolvido uma única vez, na criação. Depois disso só
 * existe o hash no banco — nem a UI nem um dump da tabela recuperam o token.
 */

const createTokenSchema = z.object({
  name: z
    .string()
    .min(2, 'Dê um nome ao token.')
    .max(60, 'Nome muito longo.')
    .regex(/^[\w\s.-]+$/, 'Use letras, números, espaço, ponto ou hífen.'),
  expiresInDays: z.number().int().min(1).max(365).optional(),
})

export interface CreateTokenResult {
  error?: string
  /** Só existe nesta resposta. Nunca é recuperável depois. */
  token?: string
  tokenPrefix?: string
}

export async function createMcpToken(
  input: z.infer<typeof createTokenSchema>,
): Promise<CreateTokenResult> {
  const parsed = createTokenSchema.safeParse(input)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return { error: 'Não autorizado.' }

  const { data: existing, error: countError } = await supabase
    .from('mcp_tokens')
    .select('id')
    .eq('user_id', user.id)
    .is('revoked_at', null)

  if (countError) return { error: 'Erro ao verificar tokens existentes.' }
  if ((existing?.length ?? 0) >= 20) {
    return {
      error: 'Limite de 20 tokens ativos atingido. Revogue algum antes.',
    }
  }

  const { token, tokenHash, tokenPrefix } = generateMcpToken()

  const expiresAt = parsed.data.expiresInDays
    ? new Date(
        Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000,
      ).toISOString()
    : null

  const { error } = await supabase.from('mcp_tokens').insert({
    user_id: user.id,
    name: parsed.data.name,
    token_hash: tokenHash,
    token_prefix: tokenPrefix,
    expires_at: expiresAt,
    last_used_at: null,
    revoked_at: null,
  })

  if (error) return { error: 'Erro ao criar token.' }

  await supabase.from('audit_logs').insert({
    user_id: user.id,
    action: 'mcp_token.create',
    resource_type: 'mcp_token',
    resource_id: null,
    metadata: { name: parsed.data.name, prefix: tokenPrefix },
    ip_address: null,
  })

  revalidatePath('/mcps')
  return { token, tokenPrefix }
}

export async function revokeMcpToken(
  tokenId: string,
): Promise<{ error?: string }> {
  const parsed = z.string().uuid().safeParse(tokenId)
  if (!parsed.success) return { error: 'ID inválido.' }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return { error: 'Não autorizado.' }

  const { data: token } = await supabase
    .from('mcp_tokens')
    .select('id, name')
    .eq('id', parsed.data)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!token) return { error: 'Token não encontrado.' }

  const { error } = await supabase
    .from('mcp_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', parsed.data)
    .eq('user_id', user.id)

  if (error) return { error: 'Erro ao revogar token.' }

  await supabase.from('audit_logs').insert({
    user_id: user.id,
    action: 'mcp_token.revoke',
    resource_type: 'mcp_token',
    resource_id: parsed.data,
    metadata: { name: token.name },
    ip_address: null,
  })

  revalidatePath('/mcps')
  return {}
}
