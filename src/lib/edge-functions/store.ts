import 'server-only'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { functionEnvironmentSchema } from './contract'
import { FunctionError } from './policy'

const leaseScopeSchema = z.object({ projectId: z.string().uuid(), ownerId: z.string().uuid(),
  projectRef: z.string().max(64).regex(/^[a-z0-9_-]+(?![\s\S])/), environment: functionEnvironmentSchema }).strict()
export interface FunctionLease { assertCurrent(): Promise<void>; release(): Promise<void> }
export async function claimFunctionLease(client: SupabaseClient, raw: z.infer<typeof leaseScopeSchema>): Promise<FunctionLease> {
  const scope = leaseScopeSchema.parse(raw)
  const token = randomUUID()
  const args = { p_project_id: scope.projectId, p_user_id: scope.ownerId, p_target_ref: scope.projectRef, p_environment: scope.environment, p_claim_token: token }
  const claimed = await client.rpc('claim_function_operation', args)
  if (claimed.error) throw new FunctionError('A reserva de funções não está disponível. Confira a migration 027 no motor antes de publicar.', 503)
  if (typeof claimed.data !== 'string' || !Number.isFinite(Date.parse(claimed.data)))
    throw new FunctionError('Há outra publicação ou configuração em andamento, ou o vínculo mudou. Aguarde até dois minutos e consulte o status antes de repetir.')
  return {
    async assertCurrent() {
      const result = await client.rpc('verify_function_operation', args)
      if (result.error || result.data !== true) throw new FunctionError('A reserva de funções expirou ou o vínculo mudou. Consulte o status antes de repetir.')
    },
    async release() {
      const result = await client.from('function_operation_leases').delete()
        .eq('target_ref', scope.projectRef).eq('project_id', scope.projectId).eq('user_id', scope.ownerId).eq('claim_token', token)
      if (result.error) throw new FunctionError('Operação concluída, mas a reserva não foi encerrada. Ela expira em até dois minutos; consulte o status antes de repetir.', 503)
    },
  }
}
