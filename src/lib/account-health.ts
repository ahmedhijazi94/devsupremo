import { decryptToken } from '@/lib/crypto'

/**
 * Verificação de validade dos tokens das contas conectadas.
 *
 * Dizer "Conectado" quando o token morreu é pior que não dizer nada: o
 * usuário só descobre quando uma operação falha, e a mensagem de erro
 * raramente aponta a causa. Aqui a tela pergunta ao provedor.
 */

export type AccountHealth = 'ok' | 'expired' | 'unknown'

/** Uma conta lenta não pode segurar a página inteira. */
const TIMEOUT_MS = 4000

async function probe(
  url: string,
  headers: Record<string, string>,
): Promise<AccountHealth> {
  try {
    const response = await fetch(url, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (response.ok) return 'ok'

    // 401 e 403 são o token perdendo validade ou permissão. Qualquer outra
    // coisa é problema do provedor, e acusar o usuário seria errado.
    if (response.status === 401 || response.status === 403) return 'expired'

    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export async function checkGithubToken(
  encryptedToken: string,
): Promise<AccountHealth> {
  try {
    return await probe('https://api.github.com/user', {
      Authorization: `Bearer ${decryptToken(encryptedToken)}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    })
  } catch {
    // Falha ao decifrar significa chave de criptografia trocada — o token
    // guardado não serve mais, mesmo que o provedor o aceitasse.
    return 'expired'
  }
}

export async function checkSupabaseToken(
  encryptedToken: string,
): Promise<AccountHealth> {
  try {
    return await probe('https://api.supabase.com/v1/organizations', {
      Authorization: `Bearer ${decryptToken(encryptedToken)}`,
    })
  } catch {
    return 'expired'
  }
}

export async function checkVercelToken(
  encryptedToken: string,
  teamId: string | null,
): Promise<AccountHealth> {
  try {
    const token = decryptToken(encryptedToken)
    // Token com escopo de time não enxerga /v2/user, então a sonda muda
    // conforme o escopo — senão uma conta válida apareceria como expirada.
    const url = teamId
      ? `https://api.vercel.com/v2/teams/${teamId}`
      : 'https://api.vercel.com/v2/user'

    return await probe(url, { Authorization: `Bearer ${token}` })
  } catch {
    return 'expired'
  }
}

export const HEALTH_LABEL: Record<AccountHealth, string> = {
  ok: 'Conectado',
  expired: 'Autorização expirada',
  unknown: 'Não foi possível verificar',
}
