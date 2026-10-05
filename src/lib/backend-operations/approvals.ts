import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { OperationAuthority } from './server'
import { OperationError, type OperationCapability, type OperationPolicy } from './contract'
import { OperationApprovalRequired, approvalSchema, type OperationApproval } from './approval-contract'
import { operationApprovalContext } from './approval-context'

const rowSchema = z.object({ id:z.uuid(),operation_id:z.uuid(),user_id:z.uuid(),project_id:z.uuid(),policy_id:z.uuid(),policy_revision:z.uuid(),
  environment:z.enum(['development','production']),device_id:z.uuid().nullable(),owner_session:z.boolean(),project_ref:z.string(),account_id:z.uuid().nullable(),
  input_digest:z.string(),capability:z.string(),resource:z.string(),affected_rows:z.number().int().nullable(),review:z.unknown(),status:z.string(),expires_at:z.string(),created_at:z.string() })
export function operationApproval(raw:unknown):OperationApproval {
  const row=rowSchema.parse(raw)
  return approvalSchema.parse({id:row.id,operationId:row.operation_id,capability:row.capability,environment:row.environment,resource:row.resource,rows:row.affected_rows,
    projectRef:row.project_ref,inputDigest:row.input_digest,policyRevision:row.policy_revision,deviceId:row.device_id,status:row.status,expiresAt:row.expires_at,createdAt:row.created_at,review:row.review})
}
/** Only called after normal policy scope/limits/device checks succeeded. The
 * context comes from the server's durable executor, never an HTTP grant field. */
export async function authorizeOneTimeOperation(authority:OperationAuthority,policy:OperationPolicy,capability:OperationCapability,
  effects:{rows?:number;resource?:string},target:{projectRef:string;accountId:string|null}):Promise<void>{
  const context=operationApprovalContext()
  if(!context||context.ownerId!==authority.ownerId||context.projectId!==authority.projectId)throw new OperationError(`A política não permite ${capability}. Prepare uma operação com ID persistente para pedir aprovação pontual.`,403)
  if(!authority.ownerSession&&!authority.deviceId)throw new OperationError('Identidade do executor não confirmada.',403)
  // A saved job resolves its current, bounded row limit at dispatch. Consent
  // grants at most the policy limit, which is shown explicitly to its owner.
  const approvedRows=capability==='jobs.run'?policy.maxRows:effects.rows??null
  const result=await authority.client.rpc('request_operation_approval',{p_owner:authority.ownerId,p_project:authority.projectId,p_operation:context.operationId,
    p_policy:policy.id,p_revision:policy.revision,p_capability:capability,p_digest:context.inputDigest,p_scope:{environment:authority.environment,deviceId:authority.deviceId??null,
      ownerSession:authority.ownerSession===true,projectRef:target.projectRef,accountId:target.accountId,resource:effects.resource??'',rows:approvedRows,
      review:context.review,expiresAt:new Date(Math.min(context.expiresAt??Infinity,Date.now()+15*60_000)).toISOString()}})
  if(result.error||!Array.isArray(result.data)||!result.data[0])throw new OperationError('A aprovação não pôde ser preparada: o pedido, destino ou autorização mudou. Prepare uma nova operação.',409)
  const row=rowSchema.parse(result.data[0]),approval=operationApproval(row)
  if(row.user_id!==authority.ownerId||row.project_id!==authority.projectId||row.policy_id!==policy.id||approval.policyRevision!==policy.revision||approval.environment!==authority.environment||approval.inputDigest!==context.inputDigest||approval.operationId!==context.operationId||approval.capability!==capability||approval.resource!==(effects.resource??'')||approval.rows!==approvedRows||row.device_id!==(authority.deviceId??null)||row.owner_session!==(authority.ownerSession===true)||row.project_ref!==target.projectRef||row.account_id!==target.accountId)throw new OperationError('A aprovação pertence a outro escopo.',403)
  if(Date.parse(approval.expiresAt)<=Date.now()||['rejected','revoked'].includes(approval.status))throw new OperationError('A aprovação expirou ou foi recusada/revogada. Prepare um novo pedido.',403)
  if(await authority.verifyIdentity()!==authority.ownerId)throw new OperationError('Dispositivo ou sessão revogados.',401)
  if(approval.status==='approved'||approval.status==='consumed')return
  if(context.collecting){context.pending=true;return}
  throw new OperationApprovalRequired(context.operationId)
}
export async function listOperationApprovals(client:SupabaseClient,ownerId:string,projectId:string,operationId?:string):Promise<OperationApproval[]>{
  let query=client.from('project_operation_approvals').select('*').eq('user_id',ownerId).eq('project_id',projectId)
  if(operationId)query=query.eq('operation_id',operationId)
  const result=await query.order('created_at',{ascending:false}).limit(100)
  if(result.error)throw new OperationError('Não foi possível consultar as aprovações. Confira a migration 039 do motor.',503)
  return (result.data??[]).map(operationApproval)
}
