import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks=vi.hoisted(()=>({owner:vi.fn(),user:vi.fn(),rpc:vi.fn(),revalidate:vi.fn(),list:vi.fn()}))
vi.mock('@/lib/auth',()=>({requireProjectOwner:mocks.owner,requireUser:mocks.user}))
vi.mock('@/lib/supabase/admin',()=>({createServiceClient:()=>({rpc:mocks.rpc})}))
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}))
vi.mock('@/lib/backend-operations/approvals',()=>({listOperationApprovals:mocks.list}))
import { decideProjectOperationApproval, getProjectOperationApprovals } from './operation-approvals'
const owner='11111111-1111-4111-8111-111111111111',projectId='22222222-2222-4222-8222-222222222222',approvalId='33333333-3333-4333-8333-333333333333'
const input={projectId,approvalId,decision:'approved'}
beforeEach(()=>{vi.clearAllMocks();mocks.owner.mockResolvedValue({user:{id:owner}});mocks.user.mockResolvedValue({user:{id:owner}});mocks.rpc.mockResolvedValue({data:true,error:null});mocks.list.mockResolvedValue([])})
describe('independent owner decisions',()=>{
  it('passes only the independently authenticated owner and immutable request ID to atomic approval',async()=>{
    expect(await decideProjectOperationApproval(input)).toEqual({ok:true})
    expect(mocks.owner).toHaveBeenCalledWith(projectId,'id,user_id')
    expect(mocks.rpc).toHaveBeenCalledWith('decide_operation_approval',{p_owner:owner,p_project:projectId,p_id:approvalId,p_decision:'approved'})
    expect(mocks.revalidate).toHaveBeenCalledWith(`/projects/${projectId}`)
  })
  it('rejects untrusted scope expansion, session replacement and provider CAS failure',async()=>{
    expect(await decideProjectOperationApproval({...input,capability:'data.delete'})).toMatchObject({ok:false})
    expect(mocks.rpc).not.toHaveBeenCalled()
    mocks.user.mockResolvedValueOnce({user:{id:approvalId}})
    expect(await decideProjectOperationApproval(input)).toMatchObject({ok:false});expect(mocks.rpc).not.toHaveBeenCalled()
    mocks.rpc.mockResolvedValue({data:false,error:{message:'private'}})
    const result=await decideProjectOperationApproval(input)
    expect(result).toMatchObject({ok:false});expect(JSON.stringify(result)).not.toContain('private')
  })
  it('requires a fresh owner session after reading metadata',async()=>{
    expect(await getProjectOperationApprovals(projectId)).toMatchObject({ok:true,approvals:[],observedAt:expect.any(String)})
    mocks.user.mockResolvedValue({user:{id:approvalId}})
    expect(await getProjectOperationApprovals(projectId)).toMatchObject({ok:false})
  })
})
