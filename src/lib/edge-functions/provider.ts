import 'server-only'
import { randomUUID } from 'node:crypto'
import { boundedJson } from '../database-inspection/provider'
import { readOnlyTransaction } from '../database-inspection/sql'
import { FUNCTION_HOOK_SECRET_NAME, functionDeploySchema, functionSlugSchema, type FunctionDeploy } from './contract'
import { FunctionError, hookSignature, isValidHookSecret } from './policy'

export interface FunctionProvider {
  list(): Promise<unknown>
  get(slug: string): Promise<unknown | null>
  deploy(bundle: FunctionDeploy): Promise<unknown>
  authConfig(): Promise<unknown>
  configureHook(uri: string, secret: string): Promise<void>
  secrets(): Promise<unknown>
  setSecret(name: string, value: string): Promise<void>
  probe(slug: string, secret?: string, validity?: 'valid' | 'invalid' | 'expired'): Promise<number>
  remove?(slug: string): Promise<void>
  dependencies?(slug: string): Promise<number>
  disableHook?(): Promise<void>
  artifact?(slug: string, version: number): Promise<FunctionDeploy>
  artifactHistory?(slug: string): Promise<{ versions: Array<{ version: number; createdAt: string; hash: string }>; complete: boolean }>
}
export function supabaseFunctionProvider(resolve: () => Promise<{ projectRef: string; token: string }>): FunctionProvider {
  const deadline = Date.now() + 55_000
  const signal = (maximum: number): AbortSignal => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new FunctionError('Tempo de verificação excedido. Consulte functions status ou functions hook status antes de repetir.', 504)
    return AbortSignal.timeout(Math.min(maximum, remaining))
  }
  const management = async (suffix: string, method = 'GET', body?: BodyInit, allowMissing = false, json = false): Promise<unknown | null> => {
    const current = await resolve()
    let response: Response
    try {
      response = await fetch(`https://api.supabase.com/v1/projects/${current.projectRef}/${suffix}`, {
        method, headers: { Authorization: `Bearer ${current.token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body } : {}), redirect: 'error', cache: 'no-store', signal: signal(method === 'POST' && suffix.startsWith('functions/deploy') ? 40_000 : 10_000),
      })
    } catch { throw new FunctionError('Supabase não confirmou a operação. Consulte functions status ou functions hook status antes de repetir; o envio pode ter sido concluído.', 502) }
    if (allowMissing && response.status === 404) { await response.body?.cancel(); return null }
    if (!response.ok) {
      await response.body?.cancel()
      throw new FunctionError(`Supabase recusou a operação de funções (HTTP ${response.status}). Confira as permissões da conexão.`, response.status === 401 || response.status === 403 ? response.status : 502)
    }
    // POST secrets documents 201 with no response schema/body. Confirmation is
    // a separate GET fingerprint read-back plus the signed handler probes.
    if (response.status === 204 || (suffix === 'secrets' && method === 'POST' && response.status === 201) || (suffix.startsWith('functions/') && method === 'DELETE' && response.status === 200)) {
      await response.body?.cancel()
      return null
    }
    try { return await boundedJson(response, 512_000) }
    catch { throw new FunctionError('Resposta do Supabase não pôde ser confirmada. Consulte o status antes de repetir.', 502) }
  }
  return {
    async remove(slug) { await management(`functions/${functionSlugSchema.parse(slug)}`, 'DELETE') },
    async disableHook() { await management('config/auth', 'PATCH', JSON.stringify({ hook_send_email_enabled: false }), false, true) },
    async dependencies(slug) {
      functionSlugSchema.parse(slug)
      const current = await resolve()
      const uri = `https://${current.projectRef}.supabase.co/functions/v1/${slug}`
      const config = await management('config/auth')
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new FunctionError('Não foi possível inspecionar dependências da função.')
      const settings = config as Record<string, unknown>
      let count = Object.entries(settings).filter(([key, value]) => /^hook_.*_uri$/.test(key) && value === uri && settings[key.replace(/_uri$/, '_enabled')] !== false).length
      // Use the project's management role in a read-only transaction. The
      // read-only API's distinct role may see no cron rows under pg_cron's RLS.
      const query = async (sql: string): Promise<unknown> => management('database/query', 'POST', JSON.stringify({ query: readOnlyTransaction(sql) }), false, true)
      const installed = await query("SELECT pg_catalog.to_regclass('cron.job') IS NOT NULL AS installed")
      if (!Array.isArray(installed) || typeof (installed[0] as Record<string, unknown> | undefined)?.installed !== 'boolean') throw new FunctionError('Dependências cron indisponíveis; remoção não autorizada.')
      if ((installed[0] as { installed: boolean }).installed) {
        const jobs = await query(`SELECT count(*)::int AS count FROM cron.job WHERE command LIKE '%${uri}%'`)
        if (!Array.isArray(jobs) || typeof (jobs[0] as Record<string, unknown> | undefined)?.count !== 'number') throw new FunctionError('Dependências cron não confirmadas.')
        count += (jobs[0] as { count: number }).count
      }
      return count
    },
    list: () => management('functions'),
    get: slug => management(`functions/${functionSlugSchema.parse(slug)}`, 'GET', undefined, true),
    async deploy(raw) {
      const bundle = functionDeploySchema.parse(raw)
      const form = new FormData()
      form.append('metadata', JSON.stringify({ name: bundle.slug, entrypoint_path: bundle.entrypoint,
        import_map_path: bundle.importMap ?? '', verify_jwt: bundle.verifyJwt, static_patterns: [] }))
      for (const file of bundle.files) form.append('file', new Blob([file.content], { type: 'application/octet-stream' }), file.path)
      return management(`functions/deploy?slug=${bundle.slug}`, 'POST', form)
    },
    authConfig: () => management('config/auth'),
    async configureHook(uri, secret) {
      const current = await resolve()
      const prefix = `https://${current.projectRef}.supabase.co/functions/v1/`
      if (!uri.startsWith(prefix) || !functionSlugSchema.safeParse(uri.slice(prefix.length)).success || !isValidHookSecret(secret))
        throw new FunctionError('Destino do hook não pertence ao projeto autorizado.')
      await management('config/auth', 'PATCH', JSON.stringify({ hook_send_email_enabled: true, hook_send_email_uri: uri, hook_send_email_secrets: secret }), false, true)
    },
    secrets: () => management('secrets'),
    async setSecret(name, value) {
      if (name !== FUNCTION_HOOK_SECRET_NAME || !isValidHookSecret(value)) throw new FunctionError('Assinatura privada do hook inválida.')
      await management('secrets', 'POST', JSON.stringify([{ name, value }]), false, true)
    },
    async probe(slug, secret, validity = 'valid') {
      const current = await resolve()
      const body = '{}'
      const id = randomUUID()
      const timestamp = String(Math.floor(Date.now() / 1000) - (validity === 'expired' ? 600 : 0))
      let response: Response
      try {
        response = await fetch(`https://${current.projectRef}.supabase.co/functions/v1/${functionSlugSchema.parse(slug)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? {
            'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': hookSignature(secret, id, timestamp, validity === 'invalid' ? '{"tampered":true}' : body),
          } : {}) }, body, redirect: 'error', cache: 'no-store', signal: signal(8000),
        })
      } catch { throw new FunctionError('Não foi possível verificar a assinatura da função. A ativação não foi confirmada; confira functions hook status.', 502) }
      await response.body?.cancel()
      return response.status
    },
  }
}
