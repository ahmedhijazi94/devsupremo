import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * State de CSRF para os fluxos de OAuth de conexão de conta.
 *
 * Antes isso vivia em `audit_logs`, que é imutável por design: não havia como
 * marcar o state como consumido, então ele valia para qualquer número de
 * callbacks dentro da janela de 10 minutos. Um state de OAuth precisa ser
 * de uso único.
 */

const TTL_MINUTES = 10

export type OAuthProvider = 'github' | 'supabase' | 'vercel'

export interface StatePayload {
  csrf: string
  projectId: string | null
}

/** Cria o state, persiste e devolve o valor a mandar ao provedor. */
export async function createOAuthState(
  supabase: SupabaseClient,
  userId: string,
  provider: OAuthProvider,
  projectId?: string | null
): Promise<string> {
  const csrf = crypto.randomBytes(32).toString('hex')

  const { error } = await supabase.from('oauth_states').insert({
    user_id: userId,
    state: csrf,
    provider,
    project_id: projectId ?? null,
    redirect_to: null,
    consumed_at: null,
    expires_at: new Date(Date.now() + TTL_MINUTES * 60_000).toISOString(),
  })

  if (error) {
    throw new Error(`Falha ao registrar o state de OAuth: ${error.message}`)
  }

  return Buffer.from(
    JSON.stringify({ csrf, projectId: projectId ?? null })
  ).toString('base64url')
}

export interface ConsumedState {
  projectId: string | null
}

/**
 * Valida o state e o marca como consumido na mesma operação.
 *
 * O update condicional (`consumed_at is null`) é o que torna o state de uso
 * único mesmo com dois callbacks chegando juntos: só um deles altera a linha.
 */
export async function consumeOAuthState(
  supabase: SupabaseClient,
  userId: string,
  provider: OAuthProvider,
  rawState: string
): Promise<ConsumedState | null> {
  const payload = decodeState(rawState)
  if (!payload) return null

  const { data, error } = await supabase
    .from('oauth_states')
    .update({ consumed_at: new Date().toISOString() })
    .eq('state', payload.csrf)
    .eq('user_id', userId)
    .eq('provider', provider)
    .is('consumed_at', null)
    .gte('expires_at', new Date().toISOString())
    .select('project_id')
    .maybeSingle()

  if (error || !data) return null

  return { projectId: (data.project_id as string | null) ?? null }
}

export function decodeState(rawState: string): StatePayload | null {
  try {
    const decoded = Buffer.from(rawState, 'base64url').toString('utf8')
    const parsed: unknown = JSON.parse(decoded)

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as StatePayload).csrf !== 'string'
    ) {
      return null
    }

    const payload = parsed as StatePayload
    // O csrf tem tamanho conhecido; qualquer outra coisa é ruído.
    if (!/^[0-9a-f]{64}$/.test(payload.csrf)) return null

    return {
      csrf: payload.csrf,
      projectId:
        typeof payload.projectId === 'string' ? payload.projectId : null,
    }
  } catch {
    return null
  }
}
