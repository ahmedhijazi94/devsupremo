import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  DeviceGrantStore,
  GrantSummary,
  PollResult,
} from './codes'

/**
 * Adapter Supabase do device flow — I/O puro sobre a tabela `bootstrap_codes`
 * (service_role). A LÓGICA do device flow (gerar/hash/aprovar/consumir) vive em
 * `codes.ts`, testada contra um store em memória; este arquivo só traduz o
 * contrato para queries Postgres. Por ser adapter de I/O, fica fora da métrica
 * de unit coverage (ver vitest.config.ts) — sua cobertura real vem do E2E.
 */
export function supabaseBootstrapStore(
  client: SupabaseClient,
): DeviceGrantStore {
  return {
    async create(row) {
      const { error } = await client.from('bootstrap_codes').insert({
        project_id: row.projectId,
        device_code_hash: row.deviceCodeHash,
        user_code: row.userCode,
        expires_at: row.expiresAt,
        created_ip: row.createdIp ?? null,
        status: 'pending',
      })
      if (error) throw new Error(`Falha ao iniciar bootstrap: ${error.message}`)
    },

    async findByUserCode(userCode, nowIso): Promise<GrantSummary | null> {
      const { data, error } = await client
        .from('bootstrap_codes')
        .select('project_id, status, expires_at')
        .eq('user_code', userCode)
        .maybeSingle()
      if (error || !data) return null
      return {
        projectId: data.project_id as string,
        status: data.status as GrantSummary['status'],
        expired: (data.expires_at as string) <= nowIso,
      }
    },

    async approve(userCode, userId, nowIso) {
      const { data, error } = await client
        .from('bootstrap_codes')
        .update({ status: 'approved', approved_at: nowIso, user_id: userId })
        .eq('user_code', userCode)
        .eq('status', 'pending')
        .gt('expires_at', nowIso)
        .select('project_id')
        .maybeSingle()
      if (error || !data) return null
      return { projectId: data.project_id as string }
    },

    async poll(deviceCodeHash, nowIso): Promise<PollResult> {
      // Consome atomicamente se aprovado e válido.
      const { data: claimed } = await client
        .from('bootstrap_codes')
        .update({ status: 'consumed', consumed_at: nowIso })
        .eq('device_code_hash', deviceCodeHash)
        .eq('status', 'approved')
        .gt('expires_at', nowIso)
        .select('user_id, project_id')
        .maybeSingle()
      if (claimed) {
        return {
          status: 'ready',
          scope: {
            userId: claimed.user_id as string,
            projectId: claimed.project_id as string,
          },
        }
      }

      const { data, error } = await client
        .from('bootstrap_codes')
        .select('status, expires_at')
        .eq('device_code_hash', deviceCodeHash)
        .maybeSingle()
      if (error || !data) return { status: 'gone' }
      if ((data.expires_at as string) <= nowIso) return { status: 'expired' }
      if (data.status === 'pending') return { status: 'pending' }
      if (data.status === 'denied') return { status: 'denied' }
      return { status: 'gone' }
    },
  }
}
