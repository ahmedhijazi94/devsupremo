import { z } from 'zod'
import { boundedJson, InspectionError } from '../database-inspection/provider'
import type { AuthAdminProvider } from './service'
import { readOnlyTransaction } from '../database-inspection/sql'

async function authProviderError(response: Response, recoveryTemplate: boolean): Promise<InspectionError> {
  const fallback = new InspectionError(`Supabase recusou a operação de autenticação (HTTP ${response.status}). ${response.status === 401 || response.status === 403 ? 'Confira as permissões da conexão; ' : ''}resultado não confirmado.`, response.status === 403 ? 403 : 502)
  if (response.status !== 400 || !recoveryTemplate) {
    await response.body?.cancel()
    return fallback
  }
  // Classify only a bounded provider diagnostic. Never return its message: it
  // may echo SMTP passwords, template contents or other private configuration.
  let raw: unknown
  try { raw = await boundedJson(response, 16_000) }
  catch { return fallback }
  const diagnostic = z.object({ message: z.union([z.string(), z.array(z.string())]).optional(), error: z.string().optional() }).safeParse(raw)
  if (!diagnostic.success) return fallback
  const text = [diagnostic.data.message, diagnostic.data.error].flat().filter(Boolean).join(' ')
  // https://supabase.com/changelog/46599-changes-to-email-template-customisation-on-free-tier
  if (/template/i.test(text) && /smtp|default email (?:provider|service)/i.test(text) && /custom|default|configur|required|enable|restrict|allow|edit/i.test(text)) {
    return new InspectionError('Supabase bloqueou a edição do template de email com o provedor padrão (HTTP 400). Novos projetos Free exigem SMTP próprio para personalizar esses templates. Para envio pela API HTTP, publique e configure o Send Email Hook pelo motor; o código ou link deve ser renderizado pela função. Nenhuma configuração foi confirmada.', 409)
  }
  return fallback
}

/** All credentials stay in the control plane; re-authorize before every provider request. */
export function supabaseAuthAdminProvider(resolve: () => Promise<{ projectRef: string; token: string }>, secrets: string[]): AuthAdminProvider {
  const send = async (url: string, method: string, headers: Record<string, string>, body?: object) => {
    const response = await fetch(url, { method, headers: { ...headers, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(12000) })
    if (!response.ok) {
      const recoveryTemplate = method === 'PATCH' && body !== undefined && Object.hasOwn(body, 'mailer_templates_recovery_content')
      throw await authProviderError(response, recoveryTemplate)
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
