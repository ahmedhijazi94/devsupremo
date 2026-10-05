'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireProjectOwner, requireUser } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/admin'
import { listOperationApprovals } from '@/lib/backend-operations/approvals'
import { OperationError } from '@/lib/backend-operations/contract'

export async function getProjectOperationApprovals(raw:unknown){
  try{
    const projectId=z.uuid().parse(raw),{user}=await requireProjectOwner(projectId,'id,user_id')
    const approvals=await listOperationApprovals(createServiceClient(),user.id,projectId)
    if((await requireUser()).user.id!==user.id)throw new OperationError('Sua sessão mudou.',401)
    return{ok:true as const,approvals,observedAt:new Date().toISOString()}
  }catch(error){return{ok:false as const,error:error instanceof OperationError?error.message:'Não foi possível carregar as aprovações.'}}
}
/** Cookie identity and framework CSRF protection are independent of the agent's
 * proposal. The action accepts no owner, capability, digest or destination. */
export async function decideProjectOperationApproval(raw:unknown){
  try{
    const input=z.object({projectId:z.uuid(),approvalId:z.uuid(),decision:z.enum(['approved','rejected','revoked'])}).strict().parse(raw)
    const {user}=await requireProjectOwner(input.projectId,'id,user_id'),client=createServiceClient()
    if((await requireUser()).user.id!==user.id)throw new OperationError('Sua sessão mudou.',401)
    const result=await client.rpc('decide_operation_approval',{p_owner:user.id,p_project:input.projectId,p_id:input.approvalId,p_decision:input.decision})
    if(result.error||result.data!==true)throw new OperationError('O pedido expirou, já foi decidido ou sua autorização/destino mudou. Atualize a lista antes de decidir.')
    revalidatePath(`/projects/${input.projectId}`)
    return{ok:true as const}
  }catch(error){return{ok:false as const,error:error instanceof OperationError?error.message:'Nenhuma nova permissão foi concedida. Confira a sessão e tente atualizar.'}}
}
