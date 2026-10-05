import { operationApprovalErrorBody } from '@/lib/backend-operations/approval-contract'
import type { NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/admin'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { supabaseCheckpointDeviceStore } from '@/lib/checkpoint/store'
import { getProject, getSupabaseCredentials } from '@/lib/projects/repository'
import { readEnvironment } from '@/lib/database-environment/store'
import { databaseRequestSchema, describeEnvironment } from '@/lib/database-environment/policy'
import { runAuthorizedDatabaseOperation } from '@/lib/database-environment/server'
import { z } from 'zod'
import { inspectionRequestSchema, inspectionOptionsSchema, requireReadTarget } from '@/lib/database-inspection/policy'
import { boundedJson, InspectionError, redactInspection, supabaseInspectionProvider } from '@/lib/database-inspection/provider'
import { runInspection } from '@/lib/database-inspection/service'
import { UnsafeSqlError } from '@/lib/database/sql-guard'
import { jobsRequestSchema, jobOperationSchema, isReadJobOperation, type JobsRequest } from '@/lib/database-jobs/policy'
import { JobsError } from '@/lib/database-jobs/provider'
import { runAuthorizedJobs } from '@/lib/database-jobs/server'
import { authRequestSchema, authOperationSchema, authOptionsSchema, type AuthRequest } from '@/lib/database-admin/options'
import { DataDeleteError, DataDeleteOperationError, deleteRequestSchema, deleteOperationSchema, deleteOptionsSchema, type DeleteRequest } from '@/lib/database-delete/contract'
import { runAuthorizedDelete } from '@/lib/database-delete/server'
import { mutationRequestSchema, mutationOperationSchema, mutationOptionsSchema, MutationError, type MutationRequest } from '@/lib/database-mutations/contract'
import { runTrackedMutation } from '@/lib/database-mutations/tracked'
import { runTrackedAuthOperation } from '@/lib/database-admin/tracked'
import { OperationError } from '@/lib/backend-operations/contract'
import { authorizeProjectOperation } from '@/lib/backend-operations/server'
import { assertSamePolicy } from '@/lib/backend-operations/policy'
import { authorizeBackend } from '@/lib/project-backend/authorization'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const isJobsRequest = (body: { operation: string }): body is JobsRequest => jobOperationSchema.safeParse(body.operation).success
const isAuthRequest = (body: { operation: string }): body is AuthRequest => authOperationSchema.safeParse(body.operation).success
const isDeleteRequest = (body: { operation: string }): body is DeleteRequest => deleteOperationSchema.safeParse(body.operation).success
const isMutationRequest = (body: { operation: string }): body is MutationRequest => mutationOperationSchema.safeParse(body.operation).success

export async function POST(request: NextRequest): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' }
  let json: unknown
  try { json = await boundedJson(request, 1_000_000) }
  catch (error) { return Response.json({ error: error instanceof InspectionError && error.status === 413 ? 'Payload excede o limite.' : 'JSON inválido.' }, { status: error instanceof InspectionError && error.status === 413 ? 413 : 400, headers }) }
  const parsed = z.union([databaseRequestSchema, inspectionRequestSchema, jobsRequestSchema, authRequestSchema, deleteRequestSchema, mutationRequestSchema]).safeParse(json)
  if (!parsed.success) return Response.json({ error: 'Payload inválido.' }, { status: 400 })
  const body = parsed.data
  const client = createServiceClient()
  const auth = await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), body.deviceSecret)
  if (!auth.ok) return Response.json({ error: 'Dispositivo não autorizado.' }, { status: 401 })
  try {
    const ownerId = auth.device.ownerUserId
    const verify = async () => {
      const project = await getProject(ownerId, body.projectId)
      return { record: await readEnvironment(client, project.id), linkedRef: project.supabase_project_ref }
    }
    const state = await verify()
    if (isMutationRequest(body)) {
      const { deviceSecret, projectId, expectedRef, ...options } = body
      return Response.json(await runTrackedMutation({ client, ownerId, projectId, expectedRef, deviceId: auth.device.id, verifyIdentity: async () => {
        const fresh = await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), deviceSecret)
        return fresh.ok ? fresh.device.ownerUserId : ''
      } }, mutationOptionsSchema.parse(options)), { headers })
    }
    if (isAuthRequest(body)) {
      const { deviceSecret, projectId, expectedRef, operationId, ...options } = body
      return Response.json(await runTrackedAuthOperation({ client, ownerId, projectId, expectedRef, deviceId: auth.device.id, verifyIdentity: async () => {
        const fresh = await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), deviceSecret)
        return fresh.ok ? fresh.device.ownerUserId : ''
      } }, authOptionsSchema.parse(options), operationId), { headers })
    }
    if (body.operation === 'status') {
      return Response.json(describeEnvironment(state.record, state.linkedRef), { headers: { 'Cache-Control': 'no-store' } })
    }
    if (isDeleteRequest(body)) {
      const { deviceSecret, projectId, expectedRef, ...rawOptions } = body
      return Response.json(await runAuthorizedDelete({ client, ownerId, projectId, expectedRef, deviceId: auth.device.id, verifyIdentity: async () => {
        const fresh = await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), deviceSecret)
        if (!fresh.ok) throw new DataDeleteError('Dispositivo não autorizado.', 401)
        return fresh.device.ownerUserId
      } }, deleteOptionsSchema.parse(rawOptions)), { headers })
    }
    if (isJobsRequest(body)) {
      const secrets = [body.deviceSecret]
      const evidence = redactInspection(await runAuthorizedJobs({ client, ownerId, projectId: body.projectId,
        expectedRef: body.expectedRef, deviceId: auth.device.id, verifyIdentity: async () => {
          const fresh = await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), body.deviceSecret)
          return fresh.ok ? fresh.device.ownerUserId : ''
        },
      }, body), secrets)
      return Response.json({ projectId: body.projectId, projectRef: body.expectedRef, environment: body.environment,
        operation: body.operation, readOnly: isReadJobOperation(body.operation), observedAt: new Date().toISOString(),
        untrustedData: true, data: evidence.value, redacted: evidence.redacted, truncated: evidence.truncated,
      }, { headers })
    }
    if ('environment' in body) {
      const options = inspectionOptionsSchema.parse({ operation: body.operation, expectedRef: body.expectedRef,
        environment: body.environment, sql: body.sql, table: body.table, limit: body.limit, offset: body.offset,
        minutes: body.minutes, source: body.source, level: body.level })
      const identity = requireReadTarget(state.record, state.linkedRef, options)
      if (options.environment === 'unknown') throw new OperationError('Autorize um ambiente registrado antes de permitir leituras pelo agente.',403)
      const environment=options.environment
      const secrets = [body.deviceSecret]
      const scope={client,ownerId,projectId:body.projectId,environment,deviceId:auth.device.id,verifyIdentity:async()=>{
        const current=await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client),body.deviceSecret)
        return current.ok?current.device.ownerUserId:''
      }}
      const binding=await authorizeBackend({ownerId,identity:scope.verifyIdentity,project:owner=>getProject(owner,body.projectId),environment:()=>readEnvironment(client,body.projectId),credentials:getSupabaseCredentials})
      let policy:{policyId:string;revision:string}|undefined
      const readPolicy=async()=>{
        const current=await authorizeProjectOperation(scope,'data.read',{rows:options.limit,resource:options.table?`public.${options.table}`:options.operation==='logs'?`logs:${options.source}`:options.operation==='report'?'database.metrics':'public'})
        if(policy)assertSamePolicy(policy,current)
        else policy=current
      }
      await readPolicy()
      const provider = supabaseInspectionProvider(async () => {
        await readPolicy()
        const credentials=await binding.resolve(true)
        await readPolicy()
        secrets.push(credentials.token)
        return credentials
      })
      const data = await runInspection(provider, options, secrets)
      await binding.verify(); await readPolicy()
      return Response.json({ projectId: body.projectId, projectRef: identity.projectRef, environment: identity.environment,
        readOnly: true, observedAt: new Date().toISOString(), operation: options.operation, untrustedData: true, data,
        limits: { rows: options.limit, offset: options.offset, maxOffset: 10000, responseBytes: 512000, statementTimeoutMs: 8000, providerTimeoutMs: 12000 },
      }, { headers })
    }
    if (!body.expectedRef) return Response.json({ error: 'Ref esperado obrigatório.' }, { status: 400 })
    return Response.json(await runAuthorizedDatabaseOperation({ client, ownerId, projectId: body.projectId, expectedRef: body.expectedRef, deviceId: auth.device.id,
      verifyIdentity: async () => {
        const current = await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), body.deviceSecret)
        return current.ok ? current.device.ownerUserId : ''
      },
    }, { operation: body.operation, expectedRef: body.expectedRef, operationId: body.operationId, migrations: body.migrations }), { headers })
  } catch (error) {
    const approval = operationApprovalErrorBody(error)
    if (approval) return Response.json(approval, { status: 403, headers })
    if (error instanceof OperationError || error instanceof MutationError) return Response.json({ error: error.message }, { status: error.status, headers })
    if (isDeleteRequest(body)) return Response.json({ error: error instanceof DataDeleteError ? error.message : 'Exclusão não confirmada. Confira o vínculo e os registros antes de preparar outro plano.',
      ...(error instanceof DataDeleteOperationError ? { code: error.operationState === 'failed' ? 'operation_failed' : 'operation_uncertain', operationId: error.operationId, operationState: error.operationState } : {}) }, { status: error instanceof DataDeleteError ? error.status : 409, headers })
    if (isAuthRequest(body)) return Response.json({ error: error instanceof InspectionError ? error.message : 'Administração de autenticação não confirmada. Verifique o vínculo, o ambiente e as permissões do projeto.' }, { status: error instanceof InspectionError ? error.status : 409, headers })
    if (isJobsRequest(body)) return Response.json({ error: error instanceof JobsError || error instanceof InspectionError ? error.message : 'Operação de jobs não autorizada ou vínculo/ambiente alterado. Consulte db status e verifique as permissões do projeto.' }, { status: error instanceof JobsError || error instanceof InspectionError ? error.status : 409, headers })
    if ('environment' in body) return Response.json({ error: error instanceof InspectionError || error instanceof UnsafeSqlError ? error.message : 'Leitura não autorizada ou vínculo/ambiente alterado. Consulte db status e verifique as permissões do projeto.' }, { status: error instanceof InspectionError ? error.status : 409, headers })
    return Response.json({ error: error instanceof Error ? error.message : 'Falha ao preparar o banco.' }, { status: 409 })
  }
}
