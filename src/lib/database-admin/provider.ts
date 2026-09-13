import { z } from 'zod'
import { boundedJson, InspectionError } from '../database-inspection/provider'
import type { AuthAdminProvider } from './service'
import { readOnlyTransaction } from '../database-inspection/sql'

/** All credentials stay in the control plane; re-authorize before every provider request. */
export function supabaseAuthAdminProvider(resolve: () => Promise<{ projectRef: string; token: string }>, secrets: string[]): AuthAdminProvider {
  const send = async (url: string, method: string, headers: Record<string, string>, body?: object) => {
    const response = await fetch(url, { method, headers: { ...headers, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(12000) })
    if (!response.ok) {
      await response.body?.cancel()
      throw new InspectionError(`Supabase recusou a operação de autenticação (HTTP ${response.status}). Confira as permissões da conexão; resultado não confirmado.`, response.status === 403 ? 403 : 502)
    }
    return response.status === 204 ? null : boundedJson(response)
  }
  const management = async (suffix: string, method: string, body?: object) => {
    const credentials = await resolve()
    secrets.push(credentials.token)
    return send(`https://api.supabase.com/v1/projects/${credentials.projectRef}/${suffix}`, method, { Authorization: `Bearer ${credentials.token}` },
      suffix === 'database/query/read-only' ? { query: readOnlyTransaction(z.object({ query: z.string() }).parse(body).query) } : body)
  }
  return {
    management,
    async user(method, userId, body) {
      const initial = await resolve()
      const keys = z.array(z.object({ name: z.string(), api_key: z.string() })).parse(await management('api-keys', 'GET'))
      const key = keys.find(entry => entry.name === 'service_role')?.api_key
      if (!key) throw new InspectionError('Credencial de administração de usuários indisponível no servidor.')
      secrets.push(key)
      const current = await resolve()
      if (current.projectRef !== initial.projectRef) throw new InspectionError('Vínculo do banco mudou.', 409)
      return send(`https://${current.projectRef}.supabase.co/auth/v1/admin/users${userId ? `/${userId}` : ''}`, method,
        { Authorization: `Bearer ${key}`, apikey: key }, body)
    },
  }
}
