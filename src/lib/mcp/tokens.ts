import crypto from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Tokens de MCP — credencial por usuário para o servidor MCP remoto.
 *
 * O token em claro só existe uma vez: no momento em que é criado e devolvido
 * ao usuário. O banco guarda apenas o SHA-256. Um vazamento da tabela não dá
 * acesso a nada.
 */

const TOKEN_PREFIX = 'sup_'
const TOKEN_BYTES = 32

export interface GeneratedToken {
  /** Valor em claro. Mostrado ao usuário uma única vez. */
  token: string
  /** SHA-256 hex — é isso que vai para o banco. */
  tokenHash: string
  /** Primeiros caracteres, para identificar o token na UI. */
  tokenPrefix: string
}

export function generateMcpToken(): GeneratedToken {
  const raw = crypto.randomBytes(TOKEN_BYTES).toString('base64url')
  const token = `${TOKEN_PREFIX}${raw}`

  return {
    token,
    tokenHash: hashMcpToken(token),
    tokenPrefix: token.slice(0, TOKEN_PREFIX.length + 6),
  }
}

export function hashMcpToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Extrai o token de um header Authorization.
 * Aceita `Bearer sup_…` e `sup_…` cru.
 */
export function parseAuthorizationHeader(header: string | null): string | null {
  if (!header) return null

  const trimmed = header.trim()
  const bearer = /^Bearer\s+(.+)$/i.exec(trimmed)
  const candidate = bearer?.[1]?.trim() ?? trimmed

  if (!candidate.startsWith(TOKEN_PREFIX)) return null
  return candidate
}

export interface ResolvedIdentity {
  userId: string
  tokenId: string
}

/**
 * Cliente com service role usado EXCLUSIVAMENTE para resolver a identidade
 * a partir do token. Toda leitura ou escrita de dados de projeto acontece
 * depois disso, sempre filtrada pelo userId resolvido aqui.
 */
function identityClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error('Supabase não configurado: falta URL ou service role key.')
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/**
 * Resolve um token em claro para a identidade do dono.
 * Retorna null para token inexistente, revogado ou expirado.
 */
export async function resolveMcpToken(
  token: string
): Promise<ResolvedIdentity | null> {
  const supabase = identityClient()
  const tokenHash = hashMcpToken(token)

  const { data, error } = await supabase
    .from('mcp_tokens')
    .select('id, user_id, revoked_at, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle()

  if (error || !data) return null
  if (data.revoked_at) return null
  if (data.expires_at && new Date(data.expires_at) < new Date()) return null

  // Registro de uso — best effort, nunca bloqueia a requisição.
  void supabase
    .from('mcp_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(undefined, () => undefined)

  return { userId: data.user_id as string, tokenId: data.id as string }
}

/**
 * Cliente de dados usado pelas ferramentas do MCP.
 *
 * Usa service role porque não há sessão de cookie numa chamada de MCP, então
 * o RLS não tem `auth.uid()` para avaliar. A contrapartida obrigatória é que
 * TODA query feita através dele passe pelo repositório em `./repository.ts`,
 * que exige userId explícito em cada operação.
 */
export function mcpDataClient(): SupabaseClient {
  return identityClient()
}
