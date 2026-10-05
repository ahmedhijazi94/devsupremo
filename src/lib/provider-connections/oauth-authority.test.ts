import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
const mocks=vi.hoisted(()=>({project:vi.fn(),authorize:vi.fn(),decrypt:vi.fn(),transport:vi.fn()}))
vi.mock('../projects/repository',()=>({getProject:mocks.project}))
vi.mock('../backend-operations/server',()=>({authorizeProjectOperation:mocks.authorize}))
vi.mock('../credentials/crypto',()=>({decryptCredential:mocks.decrypt,encryptCredential:vi.fn()}))
vi.mock('../integrations/transport',()=>({protectedJsonRequest:mocks.transport}))
vi.mock('../auth',()=>({requireUser:vi.fn()}))
import { authorizeOAuthCredentialUse } from './oauth-server'
const ownerId='11111111-1111-4111-8111-111111111111',projectId='22222222-2222-4222-8222-222222222222',connectionId='33333333-3333-4333-8333-333333333333',clientSecretId='44444444-4444-4444-8444-444444444444'
const config={version:1,environment:'development',providerKey:'example',authorization:{origin:'https://example.com',path:'/authorize'},token:{origin:'https://example.com',path:'/token'},clientId:'client',clientAuthentication:'client_secret_post',clientSecretId,scopes:['read'],connector:{version:1,origin:'https://api.example.com',authorization:'bearer',identity:{path:'/me',field:'id',account:'account-1'},operations:[{name:'list',method:'GET',path:'/items',output:['id']}]}}
function fixture(){
  let status='active',linked=true
  const selections:string[]=[]
  const client={from:(table:string)=>{
    const query={select:(fields:string)=>{selections.push(fields);return query},eq:()=>query,is:()=>query,maybeSingle:async()=>({data:table==='provider_connections'?(linked?{id:connectionId}:null):{status,config},error:null})};return query
  }} as unknown as SupabaseClient
  return{authority:{client,ownerId,projectId,deviceId:connectionId,verifyIdentity:vi.fn(async()=>ownerId)},selections,setStatus:(value:string)=>{status=value},unlink:()=>{linked=false}}
}
beforeEach(()=>{vi.clearAllMocks();mocks.project.mockResolvedValue({id:projectId});mocks.authorize.mockResolvedValue({policyId:projectId,revision:ownerId})})
describe('OAuth preflight dependencies',()=>{
  it('prepares connection and confidential client scopes using metadata without opening tokens or calling providers',async()=>{
    const f=fixture();await authorizeOAuthCredentialUse(f.authority,connectionId)
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ownerId,projectId,environment:'development'}),'credentials.use',{resource:connectionId})
    expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(),'credentials.use',{resource:clientSecretId})
    expect(f.selections).toEqual(['id','config,status']);expect(mocks.decrypt).not.toHaveBeenCalled();expect(mocks.transport).not.toHaveBeenCalled()
  })
  it('fences removed connections, uncertain refresh, changed identity and changed policy',async()=>{
    const f=fixture();f.unlink();await expect(authorizeOAuthCredentialUse(f.authority,connectionId)).rejects.toThrow('revogada')
    const uncertain=fixture();uncertain.setStatus('uncertain');await expect(authorizeOAuthCredentialUse(uncertain.authority,connectionId)).rejects.toThrow('Reconecte')
    const revoked=fixture();revoked.authority.verifyIdentity.mockResolvedValueOnce(ownerId).mockResolvedValueOnce(projectId)
    await expect(authorizeOAuthCredentialUse(revoked.authority,connectionId)).rejects.toThrow('revogada')
    mocks.authorize.mockResolvedValueOnce({policyId:projectId,revision:ownerId}).mockResolvedValueOnce({policyId:projectId,revision:connectionId})
    await expect(authorizeOAuthCredentialUse(fixture().authority,connectionId)).rejects.toThrow('autorização mudou')
  })
})
