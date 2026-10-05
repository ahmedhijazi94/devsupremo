import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/admin'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { supabaseCheckpointDeviceStore } from '@/lib/checkpoint/store'
import { getProject } from '@/lib/projects/repository'
import { boundedJson } from '@/lib/database-inspection/provider'
import { listOperationApprovals } from '@/lib/backend-operations/approvals'
import { OperationError } from '@/lib/backend-operations/contract'

export const runtime='nodejs'
export const dynamic='force-dynamic'
const requestSchema=z.object({projectId:z.uuid(),deviceSecret:z.string().min(10).max(256),operationId:z.uuid()}).strict()
/** Device metadata only. Approval is exclusively an owner-session Server Action. */
export async function POST(request:Request):Promise<Response>{
  const headers={'Cache-Control':'no-store'}
  let raw:unknown
  try{raw=await boundedJson(request,4096)}catch{return Response.json({error:'Pedido inválido.'},{status:400,headers})}
  const parsed=requestSchema.safeParse(raw)
  if(!parsed.success)return Response.json({error:'Pedido inválido.'},{status:400,headers})
  try{
    const input=parsed.data,client=createServiceClient(),store=supabaseCheckpointDeviceStore(client)
    const auth=await authenticateDeviceSecret(store,input.deviceSecret)
    if(!auth.ok)throw new OperationError('Dispositivo não autorizado.',401)
    await getProject(auth.device.ownerUserId,input.projectId)
    const approvals=await listOperationApprovals(client,auth.device.ownerUserId,input.projectId,input.operationId)
    const fresh=await authenticateDeviceSecret(store,input.deviceSecret)
    if(!fresh.ok||fresh.device.ownerUserId!==auth.device.ownerUserId||fresh.device.id!==auth.device.id)throw new OperationError('Dispositivo revogado durante a consulta.',401)
    await getProject(auth.device.ownerUserId,input.projectId)
    return Response.json({projectId:input.projectId,operationId:input.operationId,data:{approvals},observedAt:new Date().toISOString()},{headers})
  }catch(error){return Response.json({error:error instanceof OperationError?error.message:'Aprovações indisponíveis.'},{status:error instanceof OperationError?error.status:403,headers})}
}
