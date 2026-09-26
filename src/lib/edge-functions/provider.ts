import 'server-only'
import { randomUUID } from 'node:crypto'
import { boundedJson } from '../database-inspection/provider'
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
    if (response.status === 204) return null
    try { return await boundedJson(response, 512_000) }
    catch { throw new FunctionError('Resposta do Supabase não pôde ser confirmada. Consulte o status antes de repetir.', 502) }
  }
  return {
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
