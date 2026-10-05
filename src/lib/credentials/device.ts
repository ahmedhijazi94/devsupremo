import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { credentialStore } from './store'
import { applyCredential,assertCredentialAvailable,revokeCredential } from './service'
import { secretRequestStore } from '../secret-requests/store'
import { SecretRequestError } from '../secret-requests/policy'
import { authorizeProjectOperation } from '../backend-operations/server'
import { assertSamePolicy } from '../backend-operations/policy'
import { backendOperationStore } from '../backend-operations/store'
import { runTrackedOperation } from '../backend-operations/service'

export interface CredentialDeviceAuthority {client:SupabaseClient;ownerId:string;projectId:string;deviceId:string;verifyIdentity():Promise<string>}
const operationSchema=z.discriminatedUnion('operation',[
  z.object({operation:z.literal('apply'),credentialId:z.uuid(),requestId:z.uuid()}).strict(),
  z.object({operation:z.literal('revoke-credential'),credentialId:z.uuid(),operationId:z.uuid()}).strict(),
])
export async function runDeviceCredentialOperation(scope:CredentialDeviceAuthority,raw:unknown){
  const input=operationSchema.parse(raw)
  const verify=async()=>{if(await scope.verifyIdentity()!==scope.ownerId)throw new SecretRequestError('Dispositivo revogado ou sessão alterada.')}
  const base=credentialStore(scope.client,scope.ownerId,scope.projectId)
  const vault={...base,authorize:async()=>{await verify();await base.authorize()}}
  await vault.authorize()
  const credential=await vault.find(input.credentialId)
  if(!credential)throw new SecretRequestError('Credencial removida ou não encontrada neste projeto.')
  const environment=credential.environment
  if(environment!=='development'&&environment!=='production')throw new SecretRequestError('Reutilização automática exige ambiente registrado do projeto. Use o campo seguro para outro destino.')
  let policy:{policyId:string;revision:string}|undefined
  let configCapability=false
  const authorize=async()=>{
    await verify()
    const current=await authorizeProjectOperation({...scope,environment},'credentials.use',{rows:1,resource:input.credentialId})
    if(policy)assertSamePolicy(policy,current);else policy=current
    if(configCapability)assertSamePolicy(current,await authorizeProjectOperation({...scope,environment},'auth.configure',{rows:1,resource:'auth.config'}))
    return current
  }
  const delivery=secretRequestStore(scope.client,scope.ownerId,scope.projectId,async()=>{await authorize();await assertCredentialAvailable(vault,input.credentialId)},verify)
  if(input.operation==='apply'){
    await delivery.authorize()
    const request=await delivery.find(input.requestId)
    if(!request||request.target!=='supabase'||request.environment!==environment)throw new SecretRequestError('Reutilização automática exige pedido Supabase do mesmo ambiente e projeto.')
    configCapability=Boolean(request.configuration)
  }
  const originalAuthorize=vault.authorize
  vault.authorize=async()=>{await originalAuthorize();await authorize()}
  return runTrackedOperation({...backendOperationStore(scope.client,{...scope,id:input.operation==='apply'?input.requestId:input.operationId,capability:'credentials.use',input}),authorize,
    execute:async()=>{
      if(input.operation==='apply'){
        await applyCredential(vault,delivery,input.requestId,input.credentialId)
        await authorize()
        if((await delivery.find(input.requestId))?.status!=='fulfilled')throw new SecretRequestError('O envio não foi confirmado no pedido.')
        return{verified:true,requestId:input.requestId,credentialId:input.credentialId}
      }
      await revokeCredential(vault,input.credentialId);await verify()
      if(await vault.find(input.credentialId))throw new SecretRequestError('Remoção da referência não confirmada.')
      return{verified:true,revoked:true,credentialId:input.credentialId}
    },verify:async result=>result.verified===true,
  })
}
