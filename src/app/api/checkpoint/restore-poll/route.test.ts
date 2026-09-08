import { beforeEach, describe, expect, it, vi } from 'vitest'
const auth = vi.fn()
const project = vi.fn()
const environment = vi.fn()
const claim = vi.fn()
const target = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: project }) }) }) }) }))
vi.mock('@/lib/checkpoint/devices', () => ({ authenticateDeviceSecret: (...args: unknown[]) => auth(...args) }))
vi.mock('@/lib/database-environment/store', () => ({ readEnvironment: (...args: unknown[]) => environment(...args) }))
vi.mock('@/lib/checkpoint/store', () => ({ supabaseCheckpointDeviceStore: () => ({}),
  claimPendingRestoreRequests: (...args: unknown[]) => claim(...args), getCheckpointForRestore: (...args: unknown[]) => target(...args) }))
const { POST } = await import('./route')
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const request = () => new Request('http://localhost/api/checkpoint/restore-poll', { method:'POST',
  body:JSON.stringify({deviceSecret:'device-placeholder',projectId:id(1)}) })
beforeEach(()=>{
  vi.clearAllMocks()
  auth.mockResolvedValue({ok:true,device:{id:id(2),ownerUserId:id(3)}})
  project.mockResolvedValue({data:{id:id(1),user_id:id(3)},error:null})
  environment.mockResolvedValue({environment:'development'})
  claim.mockResolvedValue([{id:id(4),targetCheckpointId:id(5),claimToken:id(6),leaseExpiresAt:'2030-01-01T00:00:00Z'}])
  target.mockResolvedValue({id:id(5),projectId:id(1),commitSha:'a'.repeat(40),summary:'Saved app'})
})
describe('restore polling authority and lease delivery',()=>{
  it('delivers the claim identity only after checking owner and fresh development environment',async()=>{
    const response=await POST(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({requests:[{restoreRequestId:id(4),targetCheckpointId:id(5),targetSummary:'Saved app',claimToken:id(6),leaseExpiresAt:'2030-01-01T00:00:00Z',environment:'development'}]})
    expect(claim).toHaveBeenCalledWith(expect.anything(),{projectId:id(1),deviceId:id(2)})
  })
  it('another owner cannot claim',async()=>{
    project.mockResolvedValue({data:{id:id(1),user_id:id(9)},error:null})
    expect(await (await POST(request())).json()).toEqual({requests:[]})
    expect(claim).not.toHaveBeenCalled()
  })
  it.each(['production','unknown',null])('does not claim under environment %s',async(value)=>{
    environment.mockResolvedValue(value?{environment:value}:null)
    expect(await (await POST(request())).json()).toEqual({requests:[]})
    expect(claim).not.toHaveBeenCalled()
  })
  it('database error is retryable rather than an empty successful delivery',async()=>{
    claim.mockRejectedValue(new Error('offline'))
    expect((await POST(request())).status).toBe(503)
  })
})
