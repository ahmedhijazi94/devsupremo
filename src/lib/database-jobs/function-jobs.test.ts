import { createHash, randomUUID } from 'node:crypto'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cronHandlerSource, cronSignature, scheduledFunctionScaffold, scheduledFunctionNames } from './function-contract'
import { functionJobManifestEntrySchema, jobsManifestSchema, jobsRequestSchema } from './policy'
import { applyFunctionJobsSql, bootstrapFunctionJobsSql, functionHistoryJobsSql, functionSecretSql, runtimeFunctionJobSql } from './function-sql'
import { runJobs } from './service'
import { supabaseJobsProvider, type JobsProvider } from './provider'

const projectId = '00000000-0000-4000-8000-000000000001'
const definition = { id: 'daily-report', schedule: '0 12 * * *', timezone: 'UTC', action: { type: 'function', slug: 'daily-report', body: { digest: true } } }
const job = () => functionJobManifestEntrySchema.parse(definition)
const request = () => jobsRequestSchema.parse({ projectId, deviceSecret: 'device-fixture', expectedRef: 'project-fixture', environment: 'development', operation: 'cron-apply', manifest: { version: 1, jobs: [definition] } })
const capability = { installed: true, registry: true, timezone: 'UTC', functions: true }
const info = { id: 'fn-id', slug: 'daily-report', version: 1, status: 'ACTIVE', verifyJwt: false }
const secret = 'a'.repeat(64)
const digest = createHash('sha256').update(secret).digest('hex')
const credential = { projectRef: 'project-fixture', token: 'private-provider' }
afterEach(() => vi.unstubAllGlobals())

describe('typed scheduled functions', () => {
 it('accepts only a same-project function slug and bounded public inputs', () => {
   expect(jobsManifestSchema.parse({ version: 1, jobs: [definition] }).jobs[0]!.action.type).toBe('function')
   for (const action of [{ ...definition.action, slug: 'https://evil.test' }, { ...definition.action, url: 'https://evil.test' }, { ...definition.action, headers: { Authorization: 'secret' } }, { ...definition.action, body: { apiKey: 'private' } }, { ...definition.action, body: { nested: {} } }])
     expect(() => functionJobManifestEntrySchema.parse({ ...definition, action })).toThrow()
   expect(() => functionJobManifestEntrySchema.parse({ ...definition, timezone: 'America/New_York' })).toThrow()
   expect(scheduledFunctionNames(projectId,'daily-report').environment).toMatch(/^SUPREMO_CRON_[A-F0-9]{24}$/)
   expect(scheduledFunctionNames(projectId,'daily-report')).not.toEqual(scheduledFunctionNames(projectId,'other-function'))
 })
 it('creates Vault randomness within SQL; scheduled commands contain only a scoped lookup and signature', () => {
   const sql = functionSecretSql(projectId,'daily-report')
   expect(sql).toContain('extensions.gen_random_bytes(32)')
   expect(sql).toContain('vault.create_secret(')
   expect(sql).toContain("has_table_privilege('anon','vault.decrypted_secrets','SELECT')")
   expect(sql).not.toContain(secret)
   const runtime = runtimeFunctionJobSql(projectId,'project-fixture',job())
   expect(runtime).toContain('https://project-fixture.supabase.co/functions/v1/daily-report')
   expect(runtime).toContain('extensions.hmac(')
   expect(runtime).toContain('x-supremo-cron-signature')
   expect(runtime).not.toContain('Authorization')
   expect(runtime).not.toContain('Bearer')
   expect(runtime).not.toContain('service_role')
   expect(runtime).toContain('invocationId')
   expect(runtime).toContain('timeout_milliseconds:=10000')
   expect(runtime).not.toMatch(/^BEGIN/)
   expect(bootstrapFunctionJobsSql()).toContain('ENABLE ROW LEVEL SECURITY')
   expect(bootstrapFunctionJobsSql()).toContain('ON DELETE CASCADE')
   expect(applyFunctionJobsSql(projectId,'project-fixture',[job()])).toContain('ON CONFLICT(project_id,job_id) DO UPDATE')
   expect(applyFunctionJobsSql(projectId,'project-fixture',[job()])).toContain('active:=active')
   expect(() => applyFunctionJobsSql(projectId,'x',[])).toThrow()
   expect(() => runtimeFunctionJobSql(projectId,'../escape',job())).toThrow()
 })
 it('reports actual HTTP metadata independently from cron enqueue success', () => {
   const sql = functionHistoryJobsSql(projectId,10,0,'daily-report')
   for (const status of ['pending_response','response_expired','http_succeeded','http_failed','transport_failed','not_dispatched']) expect(sql).toContain(status)
   expect(sql).toContain('net._http_response')
   expect(sql).not.toContain('h.content')
   expect(sql).not.toContain('h.headers')
   expect(sql).not.toContain('return_message')
   expect(sql).toContain('LIMIT 11 OFFSET 0')
 })
 it('executes the generated authentication verifier for valid, forged, expired and oversized payloads', async () => {
   const javascript=ts.transpile(cronHandlerSource.replace(/^export /gm,''),{module:ts.ModuleKind.None,target:ts.ScriptTarget.ES2022}).replace(/^export /gm,'')
   const verify = new Function(javascript+';return verifyScheduledRequest;')() as (request:Request,secret:string|undefined)=>Promise<{invocationId:string;body:string;probe:boolean}|null>
   const id=randomUUID(), timestamp=Math.floor(Date.now()/1000).toString(), body='{"jobId":"daily-report"}'
   const headers={'x-supremo-cron-timestamp':timestamp,'x-supremo-cron-id':id,'x-supremo-cron-signature':cronSignature(secret,timestamp,id,body)}
   expect(await verify(new Request('https://example.test',{method:'POST',headers,body}),secret)).toEqual({invocationId:id,body,probe:false})
   expect(await verify(new Request('https://example.test',{method:'POST',headers,body:body+' '}),secret)).toBeNull()
   expect(await verify(new Request('https://example.test',{method:'POST',headers,body}),undefined)).toBeNull()
   expect(await verify(new Request('https://example.test',{method:'POST',headers:{...headers,'x-supremo-cron-timestamp':'1'},body}),secret)).toBeNull()
   expect(await verify(new Request('https://example.test',{method:'POST',headers,body:'x'.repeat(32769)}),secret)).toBeNull()
   const probeHeaders={...headers,'x-supremo-cron-signature':cronSignature(secret,timestamp,id,'')}
   expect(await verify(new Request('https://example.test',{method:'OPTIONS',headers:probeHeaders}),secret)).toMatchObject({probe:true,body:''})
   expect(scheduledFunctionScaffold(projectId,'daily-report')).toContain(scheduledFunctionNames(projectId,'daily-report').environment)
   expect(scheduledFunctionScaffold(projectId,'daily-report')).toContain('status: 501')
 })
 it('provides a dependency-free WebCrypto verifier with exact-body HMAC and replay window', () => {
   expect(cronSignature(secret,'123','id','{"a":1}')).not.toBe(cronSignature(secret,'123','id','{"a":2}'))
   expect(cronHandlerSource).toContain("crypto.subtle.verify('HMAC'")
   expect(cronHandlerSource).toContain('> 300')
   expect(cronHandlerSource).toContain("probe: request.method === 'OPTIONS'")
   expect(cronHandlerSource).not.toContain('node:')
 })
})

describe('scheduled functions orchestration', () => {
 const port = () => ({ query: vi.fn<JobsProvider['query']>().mockResolvedValueOnce([capability]).mockResolvedValueOnce([{ applied: true,job_count: 1 }]), functionInfo: vi.fn(async () => info), prepareFunctionSigner: vi.fn(async () => {}) })
 it('checks the target and private signature before installing an active schedule; never claims delivery', async () => {
   const provider=port(), result=await runJobs(provider,request())
   expect(result).toMatchObject({ applied:true,deliveryVerified:false,functionAuthentication:'hmac-sha256' })
   expect(provider.functionInfo).toHaveBeenCalledTimes(2)
   expect(provider.prepareFunctionSigner).toHaveBeenCalledWith(projectId,'daily-report')
   expect(provider.query.mock.calls[1]![0]).toContain('cron.schedule')
 })
 it('fails without writes when function capabilities or live metadata are unavailable', async () => {
   const provider = { query: vi.fn<JobsProvider['query']>().mockResolvedValue([capability]) }
   await expect(runJobs(provider,request())).rejects.toThrow('não suporta')
   expect(provider.query).toHaveBeenCalledOnce()
   const changed=port(); changed.functionInfo.mockResolvedValueOnce(info).mockResolvedValueOnce({...info,version:2})
   await expect(runJobs(changed,request())).rejects.toThrow('mudou')
   expect(changed.query).toHaveBeenCalledOnce()
 })
 it('revalidates the function authentication before resuming an existing HTTP job', async () => {
   const provider=port()
   provider.query.mockReset().mockResolvedValueOnce([capability]).mockResolvedValueOnce([{job_id:'daily-report',table_name:'daily-report',type:'function',target:'daily-report',active:false,schedule:'0 12 * * *',timezone:'UTC',created_at:'2026-09-26T00:00:00Z',updated_at:'2026-09-26T00:00:00Z',synchronized:true}]).mockResolvedValueOnce([{applied:true}])
   const input=jobsRequestSchema.parse({...request(),operation:'cron-resume',manifest:undefined,jobId:'daily-report'})
   expect(await runJobs(provider,input)).toMatchObject({applied:true})
   expect(provider.prepareFunctionSigner).toHaveBeenCalledOnce()
   expect(provider.query.mock.calls[2]![0]).toContain('active:=true')
 })
 it('does not schedule after failed authentication and installs extension tables only when necessary', async () => {
   const failed=port();failed.prepareFunctionSigner.mockRejectedValueOnce(new Error('signature unavailable'))
   await expect(runJobs(failed,request())).rejects.toThrow('signature unavailable')
   expect(failed.query).toHaveBeenCalledOnce()
   const missing=port();missing.query.mockReset().mockResolvedValueOnce([{...capability,functions:false}]).mockResolvedValueOnce([{ready:true}]).mockResolvedValueOnce([{applied:true,job_count:1}])
   await runJobs(missing,request())
   expect(missing.query.mock.calls[1]![0]).toContain('CREATE EXTENSION IF NOT EXISTS pg_net')
 })
})

describe('private signer provisioning', () => {
 it('reauthorizes every call, never places credentials in query text or probes, and leaves responses server-side', async () => {
   const resolve=vi.fn(async () => credential)
   const fetcher=vi.fn().mockResolvedValueOnce(Response.json([{secret}])).mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(new Response(null,{status:201})).mockResolvedValueOnce(new Response(null,{status:401})).mockResolvedValueOnce(new Response(null,{status:401})).mockResolvedValueOnce(new Response(null,{status:401})).mockResolvedValueOnce(new Response(null,{status:204}))
   vi.stubGlobal('fetch',fetcher)
   await supabaseJobsProvider(resolve).prepareFunctionSigner!(projectId,'daily-report')
   expect(resolve.mock.calls).toEqual([[false],[true],[false],[false],[false],[false],[false]])
   expect(String(fetcher.mock.calls[0]![1].body)).not.toContain(secret)
   expect(fetcher.mock.calls[2]![0]).toContain('/secrets')
   expect(String(fetcher.mock.calls[2]![1].body)).toContain(secret)
   const signed=fetcher.mock.calls[6]![1] as RequestInit
   expect(signed).toMatchObject({method:'OPTIONS',redirect:'error'})
   expect(JSON.stringify(signed)).not.toContain(secret)
   expect(JSON.stringify(signed)).not.toContain(credential.token)
   expect(signed.headers).toMatchObject({'x-supremo-cron-signature':expect.stringMatching(/^[a-f0-9]{64}$/)})
 })
 it('reuses the exact existing secret; does not overwrite mismatches', async () => {
   const name=scheduledFunctionNames(projectId,'daily-report').environment
   const fetcher=vi.fn().mockResolvedValueOnce(Response.json([{secret}])).mockResolvedValueOnce(Response.json([{name,digest}])).mockResolvedValueOnce(new Response(null,{status:401})).mockResolvedValueOnce(new Response(null,{status:401})).mockResolvedValueOnce(new Response(null,{status:401})).mockResolvedValueOnce(new Response(null,{status:204}))
   vi.stubGlobal('fetch',fetcher)
   await supabaseJobsProvider(async()=>credential).prepareFunctionSigner!(projectId,'daily-report')
   expect(fetcher).toHaveBeenCalledTimes(6)
   fetcher.mockReset().mockResolvedValueOnce(Response.json([{secret}])).mockResolvedValueOnce(Response.json([{name,digest:'other'}]))
   await expect(supabaseJobsProvider(async()=>credential).prepareFunctionSigner!(projectId,'daily-report')).rejects.toThrow('Nenhuma credencial foi sobrescrita')
   expect(fetcher).toHaveBeenCalledTimes(2)
 })
 it('requires denied unsigned probes and accepted signed probes; never invokes actual POST', async () => {
   const fetcher=vi.fn().mockResolvedValueOnce(Response.json([{secret}])).mockResolvedValueOnce(Response.json([{name:scheduledFunctionNames(projectId,'daily-report').environment,digest}])).mockResolvedValueOnce(new Response(null,{status:200}))
   vi.stubGlobal('fetch',fetcher)
   await expect(supabaseJobsProvider(async()=>credential).prepareFunctionSigner!(projectId,'daily-report')).rejects.toThrow('Nenhum job HTTP foi ativado')
   expect(fetcher).toHaveBeenCalledTimes(3)
 })
 it.each(['invalid', 'expired'] as const)('refuses a handler that accepts the %s signed challenge', async (accepted) => {
   const fetcher=vi.fn().mockResolvedValueOnce(Response.json([{secret}])).mockResolvedValueOnce(Response.json([{name:scheduledFunctionNames(projectId,'daily-report').environment,digest}])).mockResolvedValueOnce(new Response(null,{status:401}))
   if(accepted==='expired') fetcher.mockResolvedValueOnce(new Response(null,{status:401}))
   fetcher.mockResolvedValueOnce(new Response(null,{status:204}))
   vi.stubGlobal('fetch',fetcher)
   await expect(supabaseJobsProvider(async()=>credential).prepareFunctionSigner!(projectId,'daily-report')).rejects.toThrow('Nenhum job HTTP foi ativado')
   const headers=fetcher.mock.calls.at(-1)![1].headers as Record<string,string>
   const expected=cronSignature(secret,headers['x-supremo-cron-timestamp']!,headers['x-supremo-cron-id']!,'')
   if(accepted==='invalid') expect(headers['x-supremo-cron-signature']).not.toBe(expected)
   else {
     expect(headers['x-supremo-cron-signature']).toBe(expected)
     expect(Number(headers['x-supremo-cron-timestamp'])).toBeLessThan(Math.floor(Date.now()/1000)-300)
   }
   expect(fetcher.mock.calls.slice(2).every(([,init])=>init.method==='OPTIONS')).toBe(true)
 })
 it('allows only the selected active function with mandatory handler authentication', async () => {
   const fetcher=vi.fn().mockResolvedValueOnce(Response.json({...info,verify_jwt:false})).mockResolvedValueOnce(Response.json({...info,verify_jwt:true}))
   vi.stubGlobal('fetch',fetcher)
   expect(await supabaseJobsProvider(async()=>credential).functionInfo!('daily-report')).toEqual(info)
   await expect(supabaseJobsProvider(async()=>credential).functionInfo!('daily-report')).rejects.toThrow('validação HMAC')
   await expect(supabaseJobsProvider(async()=>credential).functionInfo!('../escape')).rejects.toThrow()
   expect(fetcher).toHaveBeenCalledTimes(2)
 })
})
