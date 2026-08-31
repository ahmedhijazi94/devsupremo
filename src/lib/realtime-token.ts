import { createHmac } from 'node:crypto'

/**
 * Assina um JWT curto para o companion falar com o Supabase Realtime, ESCOPADO
 * ao usuário (sub = userId). É o que troca o token sup_ por acesso ao canal do
 * próprio usuário — nunca um token de admin/service_role sai do servidor.
 *
 * HS256 com o SUPABASE_JWT_SECRET (o mesmo que o Supabase usa pra validar). Sem
 * dependência nova: base64url(header).base64url(payload).HMAC.
 */

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export interface RealtimeTokenClaims {
  sub: string
  role: string
  aud: string
  iat: number
  exp: number
}

/** Emite o JWT e devolve também as claims (útil para teste/log sem o segredo). */
export function signRealtimeToken(
  userId: string,
  secret: string,
  ttlSeconds = 3600,
): { token: string; claims: RealtimeTokenClaims } {
  if (!secret) throw new Error('SUPABASE_JWT_SECRET ausente.')
  const now = Math.floor(Date.now() / 1000)
  const claims: RealtimeTokenClaims = {
    sub: userId,
    role: 'authenticated',
    aud: 'authenticated',
    iat: now,
    exp: now + ttlSeconds,
  }
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify(claims))
  const signature = base64url(
    createHmac('sha256', secret).update(`${header}.${payload}`).digest(),
  )
  return { token: `${header}.${payload}.${signature}`, claims }
}

/** Confere a assinatura (usado nos testes; o Supabase faz o dele em produção). */
export function verifyRealtimeToken(token: string, secret: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const [header, payload, signature] = parts
  const expected = base64url(
    createHmac('sha256', secret).update(`${header}.${payload}`).digest(),
  )
  return signature === expected
}
