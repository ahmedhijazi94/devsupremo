import { decryptToken, encryptToken } from './crypto'

/**
 * Renovação do token do GitHub.
 *
 * O GitHub App emite access token de 8 horas e devolve um refresh token. Sem
 * renovar, tudo que fala com o GitHub morre com "Bad credentials" depois do
 * prazo. Aqui está a única lógica de renovação — os resolvers de credencial a
 * chamam e gravam o token novo.
 *
 * O refresh token rotaciona a cada uso, então renovar cedo demais desperdiça e
 * pode criar corrida. A regra: renova só quando falta pouco para expirar (ou
 * quando não sabemos a validade — projeto antigo, antes da coluna).
 */

const GITHUB_OAUTH_TOKEN = 'https://github.com/login/oauth/access_token'

/** Margem antes do vencimento, para driblar relógio torto e chamada em voo. */
const SKEW_MS = 5 * 60 * 1000

export interface GithubTokenRow {
  access_token_encrypted: string
  refresh_token_encrypted: string | null
  token_expires_at: string | null
}

/** Novos valores para gravar quando houve renovação. */
export interface GithubTokenUpdate {
  access_token_encrypted: string
  refresh_token_encrypted: string | null
  token_expires_at: string | null
}

export interface FreshGithubToken {
  /** Token válido, pronto para usar. */
  token: string
  /** Presente só quando renovou: o chamador grava no banco. */
  update?: GithubTokenUpdate
}

/**
 * Devolve um token válido a partir da linha da conta. Renova pelo refresh se o
 * atual expirou (ou está perto). Não escreve no banco — devolve o que gravar em
 * `update`, para o chamador persistir com o cliente que tem.
 */
export async function ensureFreshGithubToken(
  row: GithubTokenRow,
): Promise<FreshGithubToken> {
  const expiresAt = row.token_expires_at
    ? Date.parse(row.token_expires_at)
    : null
  const stillValid = expiresAt !== null && expiresAt - SKEW_MS > Date.now()

  // Válido, ou token clássico que não expira (sem refresh): usa o que tem.
  if (stillValid || !row.refresh_token_encrypted) {
    return { token: decryptToken(row.access_token_encrypted) }
  }

  const refreshed = await refreshGithubToken(
    decryptToken(row.refresh_token_encrypted),
  )

  return {
    token: refreshed.accessToken,
    update: {
      access_token_encrypted: encryptToken(refreshed.accessToken),
      // O refresh também rotaciona; se não veio um novo, mantém o atual.
      refresh_token_encrypted: refreshed.refreshToken
        ? encryptToken(refreshed.refreshToken)
        : row.refresh_token_encrypted,
      token_expires_at: refreshed.expiresAt,
    },
  }
}

/**
 * Token válido a partir da linha, gravando o novo se renovou. A gravação é
 * best-effort: se falhar, o token ainda vale para ESTA requisição — só não fica
 * guardado, e a próxima renova de novo. Nunca deixa a leitura quebrar por causa
 * de uma escrita.
 */
export async function freshGithubToken(
  row: GithubTokenRow,
  // PromiseLike: o query builder do Supabase é "thenable", não um Promise
  // completo — passe o builder direto, sem .then().
  persist: (update: GithubTokenUpdate) => PromiseLike<unknown>,
): Promise<string> {
  const fresh = await ensureFreshGithubToken(row)
  if (fresh.update) {
    try {
      await persist(fresh.update)
    } catch {
      // gravar falhou — o token renovado ainda serve para esta chamada
    }
  }
  return fresh.token
}

interface RefreshedToken {
  accessToken: string
  refreshToken: string | null
  expiresAt: string | null
}

async function refreshGithubToken(
  refreshToken: string,
): Promise<RefreshedToken> {
  const response = await fetch(GITHUB_OAUTH_TOKEN, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })

  const data = (await response.json().catch(() => null)) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  } | null

  if (!response.ok || !data || data.error || !data.access_token) {
    const reason = data?.error_description ?? data?.error ?? `HTTP ${response.status}`
    throw new Error(
      `Não foi possível renovar o acesso ao GitHub (${reason}). ` +
        'Reconecte o GitHub em Contas.',
    )
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null,
  }
}

/** Quando o access token, dado um expires_in em segundos, vai expirar (ISO). */
export function expiryFromNow(expiresIn: number | undefined): string | null {
  return expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null
}
