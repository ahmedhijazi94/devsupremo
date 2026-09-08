import { boundedJson } from '../database-inspection/provider'
import { readOnlyTransaction } from '../database-inspection/sql'

export class JobsError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message)
    this.name = 'JobsError'
  }
}

export interface JobsProvider {
  /** SQL is generated exclusively by the server's typed jobs service. */
  query(sql: string, options: { readOnly: boolean }): Promise<unknown[]>
}

/** Unlike arbitrary db query, the fixed jobs catalog needs the private engine
 * schema. Every request reauthorizes project/device/environment before using
 * the owner's Management API token; user-authored SQL never enters this port. */
export function supabaseJobsProvider(
  resolve: (readOnly: boolean) => Promise<{ projectRef: string; token: string }>,
): JobsProvider {
  return {
    async query(sql, { readOnly }) {
      const credentials = await resolve(readOnly)
      if (!/^[a-z0-9_-]{1,64}$/.test(credentials.projectRef)) throw new JobsError('Vínculo do banco inválido.')
      let response: Response
      try {
        response = await fetch(`https://api.supabase.com/v1/projects/${credentials.projectRef}/database/query`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: readOnly ? readOnlyTransaction(sql) : sql }),
          redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(readOnly ? 12_000 : 40_000),
        })
      } catch {
        throw new JobsError('O provedor não confirmou a operação no prazo. Consulte jobs list antes de repetir uma alteração.', 504)
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new JobsError(`Operação de jobs recusada pelo provedor (HTTP ${response.status}). Verifique suporte a pg_cron, permissões e estrutura da tabela. Nenhum executor alternativo foi usado.`, response.status === 429 ? 429 : 502)
      }
      try {
        const data = await boundedJson(response)
        if (!Array.isArray(data)) throw new Error('Invalid result')
        return data
      } catch {
        throw new JobsError('Resposta de jobs inválida ou excedeu o limite; resultado não confirmado. Consulte jobs list antes de repetir uma alteração.', 502)
      }
    },
  }
}
