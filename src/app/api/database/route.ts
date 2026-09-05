import { waitForAnonymousAuth } from '@/lib/database-environment/auth-readiness'
import type { NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/admin'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { supabaseCheckpointDeviceStore } from '@/lib/checkpoint/store'
import { getProject, getSupabaseCredentials } from '@/lib/projects/repository'
import { readEnvironment } from '@/lib/database-environment/store'
import { databaseRequestSchema, describeEnvironment } from '@/lib/database-environment/policy'
import { runDatabaseOperation } from '@/lib/database-environment/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest): Promise<Response> {
  const raw = await request.text()
  if (raw.length > 1_000_000) return Response.json({ error: 'Payload excede o limite.' }, { status: 413 })
  let json: unknown
  try { json = JSON.parse(raw) } catch { return Response.json({ error: 'JSON inválido.' }, { status: 400 }) }
  const parsed = databaseRequestSchema.safeParse(json)
  if (!parsed.success) return Response.json({ error: 'Payload inválido.' }, { status: 400 })
  const body = parsed.data
  const client = createServiceClient()
  const auth = await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), body.deviceSecret)
  if (!auth.ok) return Response.json({ error: 'Dispositivo não autorizado.' }, { status: 401 })
  try {
    const ownerId = auth.device.ownerUserId
    const verify = async () => {
      const project = await getProject(ownerId, body.projectId)
      return { record: await readEnvironment(client, project.id), linkedRef: project.supabase_project_ref }
    }
    const state = await verify()
    if (body.operation === 'status') {
      return Response.json(describeEnvironment(state.record, state.linkedRef), { headers: { 'Cache-Control': 'no-store' } })
    }
    if (!body.expectedRef) return Response.json({ error: 'Ref esperado obrigatório.' }, { status: 400 })
    const management = async (ref: string, suffix: string, method: string, payload: unknown) => {
      // Credencial do dono e do projeto; ref NUNCA é escolhido pelo cliente.
      const project = await getProject(ownerId, body.projectId)
      const credentials = await getSupabaseCredentials(ownerId, project)
      if (credentials.projectRef !== ref) throw new Error('Vínculo do banco mudou. Execute novamente após verificar o ambiente.')
      const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/${suffix}`, {
        method, headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
        ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`Banco indisponível ou operação recusada (HTTP ${res.status}). Nenhum fallback local foi utilizado.`)
      return res.json() as Promise<unknown>
    }
    const result = await runDatabaseOperation({
      verify,
      query: (ref, sql) => management(ref, 'database/query', 'POST', { query: sql }),
      configureAuth: async (ref) => {
        // Patch mínimo: preserva CAPTCHA, limites, providers e confirmação de e-mail.
        await management(ref, 'config/auth', 'PATCH', { external_anonymous_users_enabled: true })
        const config = await management(ref, 'config/auth', 'GET', null) as { external_anonymous_users_enabled?: boolean }
        if (config.external_anonymous_users_enabled !== true) throw new Error('Anonymous Auth não foi confirmado pelo provedor.')
        const keys = await management(ref, 'api-keys', 'GET', null) as Array<{ name: string; api_key: string }>
        const key = keys.find((entry) => entry.name === 'anon')?.api_key
        if (!key) throw new Error('Chave pública de autenticação indisponível.')
        await waitForAnonymousAuth(async () => {
          const response = await fetch(`https://${ref}.supabase.co/auth/v1/settings`, {
            headers: { apikey: key }, cache: 'no-store', signal: AbortSignal.timeout(3000),
          })
          if (!response.ok) return false
          const settings = await response.json() as { external?: { anonymous_users?: boolean }; disable_signup?: boolean }
          return settings.external?.anonymous_users === true && settings.disable_signup === false
        })
      },
    }, body.expectedRef, body.operation, body.migrations)
    return Response.json(result)
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Falha ao preparar o banco.' }, { status: 409 })
  }
}
