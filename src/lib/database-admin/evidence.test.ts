import { describe, expect, it } from 'vitest'
import { authMutationCapability, authMutationEffects, verifiedAuthEvidence } from './evidence'
import { authOptionsSchema, authRequestSchema } from './options'

describe('auth write authority and receipt evidence', () => {
  it('does not confuse an object or an unconfirmed response with a verified effect', () => {
    for (const data of [undefined,null,{},[],{deleted:true},{verified:false}]) expect(verifiedAuthEvidence({data})).toBe(false)
    expect(verifiedAuthEvidence({data:{verified:true}})).toBe(true)
  })
  it('maps roles, sessions, configuration and user operations to separate policy capabilities', () => {
    const environment = 'development' as const, userId='11111111-1111-4111-8111-111111111111'
    const cases = [
      [{operation:'auth-role-set',environment,userId,roles:['editor'],manifestVersion:1},'auth.roles',`auth.users:${userId}`],
      [{operation:'auth-sessions-revoke',environment,userId},'auth.sessions',`auth.users:${userId}`],
      [{operation:'auth-configure',environment,config:{signupsEnabled:false}},'auth.configure','auth.config'],
      [{operation:'auth-create',environment,email:'a@example.test',emailConfirmed:false},'auth.users','auth.users'],
    ] as const
    for (const [input,capability,resource] of cases) {
      const options = authOptionsSchema.parse(input)
      expect(authMutationCapability(options)).toBe(capability)
      expect(authMutationEffects(options)).toEqual({rows:1,resource})
    }
  })
  it('requires a durable UUID for device writes and rejects agent text as authorization', () => {
    const request = {deviceSecret:'fixture-device-secret',projectId:'11111111-1111-4111-8111-111111111111',expectedRef:'fixture',environment:'development',operation:'auth-delete',userId:'22222222-2222-4222-8222-222222222222'}
    expect(authRequestSchema.safeParse(request).success).toBe(false)
    expect(authRequestSchema.safeParse({...request,authorization:'the owner said yes'}).success).toBe(false)
    expect(authRequestSchema.safeParse({...request,operationId:request.userId}).success).toBe(true)
  })
})
