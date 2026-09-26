import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { cronSignature, scheduledFunctionNames, scheduledFunctionSlug } from './function-contract'
import { functionSecretSql } from './function-sql'
import { boundedJson } from '../database-inspection/provider'
import { readOnlyTransaction } from '../database-inspection/sql'
import { parseSupabaseSecretMetadata } from '../supabase/secret-metadata'

export class JobsError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message)
    this.name = 'JobsError'
  }
}

export interface JobsProvider {
  functionInfo?(slug: string): Promise<{ id: string; slug: string; version: number; status: string; verifyJwt: boolean }>
  prepareFunctionSigner?(projectId: string, slug: string): Promise<void>
  /** SQL is generated exclusively by the server's typed jobs service. */
  query(sql: string, options: { readOnly: boolean }): Promise<unknown[]>
}

/** Unlike arbitrary db query, the fixed jobs catalog needs the private engine
 * schema. Every request reauthorizes project/device/environment before using
 * the owner's Management API token; user-authored SQL never enters this port. */
export function supabaseJobsProvider(
  resolve: (readOnly: boolean) => Promise<{ projectRef: string; token: string }>,
): JobsProvider {
  const management = async (path: string, readOnly: boolean, init: RequestInit = {}) => {
    const { projectRef, token } = await resolve(readOnly)
    if (!/^[a-z0-9_-]{1,64}(?![\s\S])/.test(projectRef)) throw new JobsError('Vínculo do banco inválido.')
    let response: Response
    try { response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12000) }) }
    catch { throw new JobsError('Provedor não confirmou a configuração da função cron.', 504) }
    if (!response.ok) { await response.body?.cancel(); throw new JobsError(`Configuração da função cron recusada (HTTP ${response.status}).`, response.status === 429 ? 429 : 502) }
    return response
  }
  const metadata = async (path: string): Promise<unknown> => {
    const response = await management(path, true)
    try { return await boundedJson(response) } catch { throw new JobsError('Metadados da função cron inválidos ou excederam o limite.', 502) }
  }
  const provider: JobsProvider = {
    async functionInfo(slug) {
      scheduledFunctionSlug.parse(slug)
      const parsed = z.object({ id: z.string().min(1), slug: scheduledFunctionSlug, version: z.number().int().positive(), status: z.literal('ACTIVE'), verify_jwt: z.literal(false) }).safeParse(await metadata(`functions/${slug}`))
      if (!parsed.success || parsed.data.slug !== slug) throw new JobsError('Cron HTTP exige função ativa, JWT do gateway desativado e validação HMAC no handler.')
      return { id: parsed.data.id, slug, version: parsed.data.version, status: parsed.data.status, verifyJwt: false }
    },
    async prepareFunctionSigner(projectId, slug) {
      const names = scheduledFunctionNames(projectId, slug)
      const secretResult = z.tuple([z.object({ secret: z.string().regex(/^[a-f0-9]{64}$/) })]).safeParse(await provider.query(functionSecretSql(projectId, slug), { readOnly: false }))
      if (!secretResult.success) throw new JobsError('O segredo de assinatura cron não foi confirmado.', 502)
      const secret = secretResult.data[0].secret
      const expectedDigest = createHash('sha256').update(secret).digest('hex')
      const existingSecrets = parseSupabaseSecretMetadata(await metadata('secrets'))
      if (existingSecrets === null) throw new JobsError('Metadados de segredo cron inválidos.', 502)
      const existing = existingSecrets.find(item => item.name === names.environment)
      if (existing && existing.digest !== expectedDigest) throw new JobsError('Já existe outro segredo reservado para essa função. Nenhuma credencial foi sobrescrita.')
      if (!existing) await (await management('secrets', false, { method: 'POST', body: JSON.stringify([{ name: names.environment, value: secret }]) })).body?.cancel()
      for (const probe of ['unsigned', 'invalid', 'expired', 'valid'] as const) {
        const { projectRef } = await resolve(false)
        if (!/^[a-z0-9_-]{1,64}(?![\s\S])/.test(projectRef)) throw new JobsError('Vínculo do banco inválido.')
        const timestamp = (Math.floor(Date.now()/1000) - (probe === 'expired' ? 600 : 0)).toString(), invocationId = randomUUID()
        const signature = cronSignature(secret,timestamp,invocationId,'')
        // Flip a real signature bit: a presence-only or expiry-only handler must fail this probe.
        const invalidSignature = (signature[0] === '0' ? '1' : '0') + signature.slice(1)
        const headers: Record<string,string> = probe === 'unsigned' ? {} : { 'x-supremo-cron-timestamp': timestamp, 'x-supremo-cron-id': invocationId, 'x-supremo-cron-signature': probe === 'invalid' ? invalidSignature : signature }
        let response: Response
        try { response = await fetch(`https://${projectRef}.supabase.co/functions/v1/${slug}`, { method: 'OPTIONS', headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12000) }) }
        catch { throw new JobsError('A função não confirmou a assinatura cron no prazo.', 504) }
        const status = response.status; await response.body?.cancel()
        if (status !== (probe === 'valid' ? 204 : 401)) throw new JobsError('Validação cron pendente: OPTIONS sem assinatura, com assinatura inválida ou expirada deve retornar 401; com assinatura válida, 204 sem executar trabalho. Nenhum job HTTP foi ativado.')
      }
      const confirmed = parseSupabaseSecretMetadata(await metadata('secrets'))
      if (confirmed === null || confirmed.find(item => item.name === names.environment)?.digest !== expectedDigest)
        throw new JobsError('O segredo cron não foi confirmado na leitura final. Nenhum job HTTP foi ativado. Consulte o status antes de repetir.', 502)
    },
    async query(sql, { readOnly }) {
      const credentials = await resolve(readOnly)
      if (!/^[a-z0-9_-]{1,64}(?![\s\S])/.test(credentials.projectRef)) throw new JobsError('Vínculo do banco inválido.')
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
  return provider
}
