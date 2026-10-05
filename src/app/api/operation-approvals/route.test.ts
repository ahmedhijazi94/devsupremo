import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks=vi.hoisted(()=>({client:{},device:vi.fn(),project:vi.fn(),list:vi.fn()}))
vi.mock('@/lib/supabase/admin',()=>({createServiceClient:()=>mocks.client}))
vi.mock('@/lib/checkpoint/store',()=>({supabaseCheckpointDeviceStore:()=>({})}))
vi.mock('@/lib/checkpoint/devices',()=>({authenticateDeviceSecret:mocks.device}))
vi.mock('@/lib/projects/repository',()=>({getProject:mocks.project}))
vi.mock('@/lib/backend-operations/approvals',()=>({listOperationApprovals:mocks.list}))
import { POST } from './route'
const owner='11111111-1111-4111-8111-111111111111',projectId='22222222-2222-4222-8222-222222222222',operationId='33333333-3333-4333-8333-333333333333'
const input={projectId,operationId,deviceSecret:'private-device-fixture'}
const request=(body:unknown=input)=>new Request('https://supremo.test/api/operation-approvals',{method:'POST',body:JSON.stringify(body)})
beforeEach(()=>{vi.clearAllMocks();mocks.device.mockResolvedValue({ok:true,device:{id:operationId,ownerUserId:owner}});mocks.project.mockResolvedValue({id:projectId});mocks.list.mockResolvedValue([{operationId,status:'pending'}])})
describe('device approval metadata endpoint',()=>{
  it('returns the exact owner/project/operation metadata with fresh device verification',async()=>{
    const response=await POST(request())
    expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toMatchObject({projectId,operationId,data:{approvals:[{operationId,status:'pending'}]}})
    expect(mocks.list).toHaveBeenCalledWith(mocks.client,owner,projectId,operationId)
    expect(mocks.device).toHaveBeenCalledTimes(2);expect(mocks.project).toHaveBeenCalledTimes(2)
  })
  it('rejects client claims of approval and never exposes a decision endpoint',async()=>{
    expect((await POST(request({...input,status:'approved'}))).status).toBe(400)
    expect((await POST(request({...input,ownerId:owner}))).status).toBe(400)
    expect(mocks.list).not.toHaveBeenCalled()
  })
  it('rejects cross-owner lookup and revocation during the query',async()=>{
    mocks.project.mockRejectedValueOnce(new Error('private'))
    expect((await POST(request())).status).toBe(403);expect(mocks.list).not.toHaveBeenCalled()
    mocks.device.mockResolvedValueOnce({ok:true,device:{id:operationId,ownerUserId:owner}}).mockResolvedValueOnce({ok:false})
    expect((await POST(request())).status).toBe(401)
  })
})
