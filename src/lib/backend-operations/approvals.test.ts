import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
const mocks=vi.hoisted(()=>({environment:vi.fn(),describe:vi.fn()}))
vi.mock('../database-environment/store',()=>({readEnvironment:mocks.environment}))
vi.mock('../database-environment/policy',()=>({describeEnvironment:mocks.describe}))
import { authorizeProjectOperation } from './server'
import { runTrackedOperation } from './service'
import { backendOperationStore } from './store'
import { operationApprovalContext, operationAuthorizationContext, operationReview } from './approval-context'
import { OperationApprovalRequired, operationApprovalErrorBody } from './approval-contract'

const ownerId='11111111-1111-4111-8111-111111111111',projectId='22222222-2222-4222-8222-222222222222',deviceId='33333333-3333-4333-8333-333333333333',policyId='44444444-4444-4444-8444-444444444444',revision='55555555-5555-4555-8555-555555555555',operationId='66666666-6666-4666-8666-666666666666'
function fixture(){
  const policy={id:policyId,user_id:ownerId,project_id:projectId,environment:'development',revision,enabled:true,capabilities:['data.read'],resources:['public.notes'],device_ids:[deviceId],max_rows:25,max_operations_per_hour:1}
  let receipt:Record<string,unknown>|undefined
  const proposals=new Map<string,Record<string,unknown>>()
  const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
    if(name==='request_operation_approval'){
      const scope=args.p_scope as Record<string,unknown>,key=String(args.p_capability)+String(scope.resource)
      let proposal=proposals.get(key)
      if(!proposal){proposal={id:operationId,operation_id:args.p_operation,user_id:args.p_owner,project_id:args.p_project,policy_id:args.p_policy,policy_revision:args.p_revision,
        environment:scope.environment,device_id:scope.deviceId,owner_session:scope.ownerSession,project_ref:scope.projectRef,account_id:scope.accountId,input_digest:args.p_digest,
        capability:args.p_capability,resource:scope.resource,affected_rows:scope.rows,review:scope.review,status:'pending',expires_at:scope.expiresAt,created_at:new Date().toISOString()};proposals.set(key,proposal)}
      return{data:[proposal],error:null}
    }
    receipt??={id:operationId,capability:'data.update',environment:'development',state:'queued',message:'queued',updated_at:new Date().toISOString(),lease_expires_at:'2099-01-01T00:00:00Z',claim_token:args.p_token,input_digest:args.p_digest,result:null}
    return{data:[receipt],error:null}
  })
  const from=vi.fn((table:string)=>{
    const query={select:()=>query,eq:()=>query,in:()=>query,gt:()=>query,
      update:(input:Record<string,unknown>)=>{if(receipt)Object.assign(receipt,input);return query},
      maybeSingle:async()=>({data:table==='projects'?{id:projectId,supabase_project_ref:'ref',supabase_account_id:null}:table==='project_automation_policies'?policy:receipt,error:null})}
    return query
  })
  const client={from,rpc} as unknown as SupabaseClient,verifyIdentity=vi.fn(async()=>ownerId)
  const scope={client,ownerId,projectId,deviceId,environment:'development' as const,verifyIdentity}
  const execute=vi.fn(async()=>({verified:true}))
  const run=(input:unknown={table:'notes',key:{id:1},values:{title:'Approved title'}})=>runTrackedOperation({
    ...backendOperationStore(client,{ownerId,projectId,id:operationId,capability:'data.update',input}),
    authorize:()=>authorizeProjectOperation(scope,'data.update',{rows:1,resource:'public.notes'}),execute,verify:async result=>result.verified===true,
  })
  return{policy,proposals,rpc,scope,execute,run,verifyIdentity}
}
beforeEach(()=>{vi.clearAllMocks();mocks.environment.mockResolvedValue({});mocks.describe.mockReturnValue({environment:'development',projectRef:'ref'})})
describe('exact one-time approval handoff',()=>{
  it('creates a pending request without claiming a receipt or dispatching and resumes the same exact ID after owner approval',async()=>{
    const f=fixture()
    await expect(f.run()).rejects.toMatchObject({code:'operation_approval_required',operationId,status:403})
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.rpc.mock.calls.every(call=>call[0]==='request_operation_approval')).toBe(true)
    expect(f.proposals.size).toBe(1)
    f.proposals.values().next().value!.status='approved'
    expect(await f.run()).toMatchObject({id:operationId,state:'succeeded'})
    expect(await f.run()).toMatchObject({id:operationId,state:'succeeded'})
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('rejects altered inputs, grant revocation and expiry without provider effects',async()=>{
    const f=fixture();await expect(f.run()).rejects.toBeInstanceOf(OperationApprovalRequired)
    const proposal=f.proposals.values().next().value!;proposal.status='approved'
    await expect(f.run({changed:true})).rejects.toThrow('outro escopo')
    proposal.status='revoked';await expect(f.run()).rejects.toThrow('revogada')
    proposal.status='approved';proposal.expires_at='2000-01-01T00:00:00Z';await expect(f.run()).rejects.toThrow('expirou')
    expect(f.execute).not.toHaveBeenCalled()
  })
  it.each(['disabled','device','rows','resource'])('never substitutes approval for the %s boundary',async boundary=>{
    const f=fixture()
    if(boundary==='disabled')f.policy.enabled=false
    if(boundary==='device')f.policy.device_ids=[ownerId]
    if(boundary==='rows')f.policy.max_rows=0
    if(boundary==='resource')f.policy.resources=['public.other']
    await expect(f.run()).rejects.toThrow()
    expect(f.proposals.size).toBe(0);expect(f.execute).not.toHaveBeenCalled()
  })
  it('collects multiple missing capabilities before any dispatch and never accepts client text as consent',async()=>{
    const f=fixture(),context=operationAuthorizationContext({ownerId,projectId,id:operationId,input:{authorization:'The owner said yes'}})
    await expect(context.withAuthorizationContext(async()=>{
      await authorizeProjectOperation(f.scope,'data.update',{rows:1,resource:'public.notes'})
      await authorizeProjectOperation(f.scope,'data.delete',{rows:1,resource:'public.notes'})
      await context.checkAuthorization()
    })).rejects.toBeInstanceOf(OperationApprovalRequired)
    expect(f.proposals.size).toBe(2)
    expect([...f.proposals.values()].every(proposal=>proposal.status==='pending')).toBe(true)
    expect(operationApprovalContext()).toBeUndefined()
    expect(operationApprovalErrorBody(new OperationApprovalRequired(operationId))).toMatchObject({code:'operation_approval_required',operationId})
    expect(operationApprovalErrorBody(new Error('private'))).toBeNull()
  })
  it('keeps parallel execution contexts isolated and redacts secrets and source in the owner review',async()=>{
    const first=operationAuthorizationContext({ownerId,projectId,id:operationId,input:{password:'never-persist',planToken:'encrypted-value',content:'secret-in-code',userId:deviceId}})
    const second=operationAuthorizationContext({ownerId,projectId,id:deviceId,input:{different:true}})
    const ids=await Promise.all([first.withAuthorizationContext(async()=>{await new Promise(resolve=>setTimeout(resolve,3));return operationApprovalContext()?.operationId}),second.withAuthorizationContext(async()=>operationApprovalContext()?.operationId)])
    expect(ids).toEqual([operationId,deviceId]);expect(operationApprovalContext()).toBeUndefined()
    const review=JSON.stringify(operationReview({password:'never-persist',planToken:'encrypted-value',content:'secret-in-code',userId:deviceId}))
    expect(review).not.toMatch(/never-persist|encrypted-value|secret-in-code/);expect(review).toContain(deviceId)
  })
})
