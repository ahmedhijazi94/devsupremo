import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptCredential } from './crypto'
import type { CredentialPort,CredentialRecord } from './service'
import type { SecretRequestPort } from '../secret-requests/service'
import type { SecretRequestRecord } from '../secret-requests/policy'
import { OperationError,type OperationReceipt } from '../backend-operations/contract'

const mocks=vi.hoisted(()=>({vault:vi.fn(),delivery:vi.fn(),policy:vi.fn(),store:vi.fn()}))
vi.mock('./store',()=>({credentialStore:mocks.vault}))
vi.mock('../secret-requests/store',()=>({secretRequestStore:mocks.delivery}))
vi.mock('../backend-operations/server',()=>({authorizeProjectOperation:mocks.policy}))
vi.mock('../backend-operations/store',()=>({backendOperationStore:mocks.store}))
import { runDeviceCredentialOperation } from './device'
import type { SupabaseClient } from '@supabase/supabase-js'

const ownerId='11111111-1111-4111-8111-111111111111',projectId='22222222-2222-4222-8222-222222222222',credentialId='33333333-3333-4333-8333-333333333333',requestId='44444444-4444-4444-8444-444444444444'
function fixture(){
  let record:CredentialRecord|null={id:credentialId,userId:ownerId,projectId,name:'PAYMENT_KEY',environment:'development',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),encryptedValue:encryptCredential('private-test-value',{id:credentialId,userId:ownerId,projectId,environment:'development'})}
  const request:SecretRequestRecord={id:requestId,name:'PAYMENT_KEY',description:'Backend',target:'supabase',environment:'development',targetRef:'fixture',accountId:ownerId,status:'pending'}
  const vault:CredentialPort={userId:ownerId,projectId,authorize:vi.fn(async()=>{}),find:vi.fn(async()=>record),list:vi.fn(async()=>[]),insert:vi.fn(async()=>{}),remove:vi.fn(async()=>{record=null}),audit:vi.fn(async()=>{})}
  const send=vi.fn(async()=>{})
  const delivery:SecretRequestPort={authorize:vi.fn(async()=>{}),resolve:async()=>({target:'supabase',environment:'development',targetRef:'fixture',accountId:ownerId}),find:async()=>request,list:async()=>[request],insert:async()=>{},audit:async()=>{},claim:async()=>({id:requestId,expiresAt:new Date(Date.now()+120000).toISOString()}),release:async()=>{},deliver:send,fulfill:async()=>{request.status='fulfilled'},dismiss:async()=>{}}
  mocks.vault.mockReturnValue(vault)
  mocks.delivery.mockImplementation((_client:unknown,_owner:string,_project:string,guard:()=>Promise<void>,verify:()=>Promise<void>)=>({...delivery,authorize:async()=>{await verify();await delivery.authorize()},deliver:async(...args:Parameters<SecretRequestPort['deliver']>)=>{await guard();await delivery.deliver(...args)}}))
  const receipts=new Map<string,OperationReceipt>()
  mocks.store.mockImplementation((_client:unknown,scope:{id:string})=>({
    claim:async()=>{const existing=receipts.get(scope.id);const receipt:OperationReceipt=existing??{id:scope.id,capability:'credentials.use',environment:'development',state:'queued',updatedAt:new Date().toISOString(),message:'',result:null};receipts.set(scope.id,receipt);return{acquired:!existing,token:'claim',receipt}},
    update:async(id:string,_claim:string,state:OperationReceipt['state'],message:string,result?:Record<string,unknown>)=>{const receipt={...receipts.get(id)!,state,message,result:result??null};receipts.set(id,receipt);return receipt},
  }))
  const scope={client:{} as SupabaseClient,ownerId,projectId,deviceId:ownerId,verifyIdentity:vi.fn(async()=>ownerId)}
  const input={operation:'apply',credentialId,requestId}
  return{vault,delivery,send,scope,input,request,receipts}
}
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('ENCRYPTION_KEY','ab'.repeat(32));mocks.policy.mockResolvedValue({policyId:ownerId,revision:projectId})})
describe('device use of saved project credentials',()=>{
  it('uses policy, live device and immutable reference, and consumes the request only once',async()=>{
    const f=fixture()
    expect(await runDeviceCredentialOperation(f.scope,f.input)).toMatchObject({state:'succeeded',result:{verified:true,requestId,credentialId}})
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({id:requestId}),expect.objectContaining({targetRef:'fixture'}),'private-test-value',expect.anything())
    expect(mocks.policy).toHaveBeenCalledWith(expect.objectContaining({deviceId:ownerId}),'credentials.use',{rows:1,resource:credentialId})
    expect(await runDeviceCredentialOperation(f.scope,f.input)).toMatchObject({state:'succeeded'})
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(JSON.stringify([...f.receipts.values()])).not.toContain('private-test-value')
  })
  it('denies a disabled policy before decrypting or delivering a saved value',async()=>{
    const f=fixture();mocks.policy.mockRejectedValue(new OperationError('revoked',403))
    await expect(runDeviceCredentialOperation(f.scope,f.input)).rejects.toThrow('revoked')
    expect(f.send).not.toHaveBeenCalled();expect(f.vault.audit).not.toHaveBeenCalled()
  })
  it('blocks revoked devices before lookup and again at delivery',async()=>{
    const f=fixture();f.scope.verifyIdentity.mockResolvedValue('revoked')
    await expect(runDeviceCredentialOperation(f.scope,f.input)).rejects.toThrow(/revogado/)
    expect(f.vault.find).not.toHaveBeenCalled()
    f.scope.verifyIdentity.mockResolvedValue(ownerId)
    f.vault.audit=async()=>{f.scope.verifyIdentity.mockResolvedValue('revoked')}
    expect(await runDeviceCredentialOperation(f.scope,f.input)).toMatchObject({state:'uncertain'})
    expect(f.send).not.toHaveBeenCalled()
  })
  it('requires auth.configure as well when a saved credential changes SMTP settings',async()=>{
    const f=fixture();f.request.configuration={kind:'supabase-smtp',provider:'resend',senderEmail:'a@example.test',senderName:'App'}
    mocks.policy.mockImplementation(async(_scope:unknown,capability:string)=>{if(capability==='auth.configure')throw new OperationError('configure not authorized',403);return{policyId:ownerId,revision:projectId}})
    await expect(runDeviceCredentialOperation(f.scope,f.input)).rejects.toThrow(/not authorized/)
    expect(f.send).not.toHaveBeenCalled()
  })
  it.each(['environment','target'] as const)('rejects mismatched %s before using the value',async field=>{
    const f=fixture();if(field==='environment')f.request.environment='production';else f.request.target='vercel'
    await expect(runDeviceCredentialOperation(f.scope,f.input)).rejects.toThrow(/mesmo ambiente/)
    expect(f.send).not.toHaveBeenCalled()
  })
  it('retains an uncertain receipt after lost provider response without a second delivery',async()=>{
    const f=fixture();f.send.mockRejectedValue(new Error('secret response lost'))
    expect(await runDeviceCredentialOperation(f.scope,f.input)).toMatchObject({state:'uncertain'})
    expect(await runDeviceCredentialOperation(f.scope,f.input)).toMatchObject({state:'uncertain'})
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('verifies removal, and never reports a retained credential as revoked',async()=>{
    const f=fixture(),input={operation:'revoke-credential',credentialId,operationId:requestId}
    f.vault.remove=async()=>{}
    expect(await runDeviceCredentialOperation(f.scope,input)).toMatchObject({state:'uncertain'})
    const next=fixture()
    expect(await runDeviceCredentialOperation(next.scope,input)).toMatchObject({state:'succeeded',result:{revoked:true}})
  })
})
