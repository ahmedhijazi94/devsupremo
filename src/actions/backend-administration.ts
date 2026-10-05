'use server'
import { requireProjectOwner, requireUser } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/admin'
import { backendAdministrationSchema, dataEditorInputSchema, dataImportInputSchema, type AdministrationResult } from '@/lib/project-backend/administration'
import { runTrackedMutation } from '@/lib/database-mutations/tracked'
import { mutationActionSchema, MutationError } from '@/lib/database-mutations/contract'
import { runTrackedAuthOperation } from '@/lib/database-admin/tracked'
import { InspectionError } from '@/lib/database-inspection/provider'
import { runAuthorizedFunctions } from '@/lib/edge-functions/server'
import { FunctionError } from '@/lib/edge-functions/policy'
import { functionOptionsSchema, isFunctionRead } from '@/lib/edge-functions/contract'
import { OperationError } from '@/lib/backend-operations/contract'
import { randomUUID } from 'node:crypto'
import { runAuthorizedJobs } from '@/lib/database-jobs/server'
import { JobsError } from '@/lib/database-jobs/provider'
import { jobsRequestSchema } from '@/lib/database-jobs/policy'

const explanation = (error: unknown) => error instanceof OperationError || error instanceof MutationError || error instanceof InspectionError || error instanceof FunctionError || error instanceof JobsError ? error.message : 'Operação não confirmada. Confira a autorização, o ambiente e os campos informados.'

export async function administerProjectBackend(raw: unknown): Promise<AdministrationResult> {
  const parsed = backendAdministrationSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Pedido inválido. Confira os campos e a operação.' }
  try {
    const input = parsed.data
    const { user } = await requireProjectOwner(input.projectId, 'id,user_id')
    const scope = { client: createServiceClient(), ownerId: user.id, ownerSession: true as const, projectId: input.projectId, expectedRef: input.expectedRef, verifyIdentity: async () => (await requireUser()).user.id }
    if (input.kind === 'data') return { ok: true, data: await runTrackedMutation(scope, input.options) }
    if (input.kind === 'function') return { ok: true, data: await runAuthorizedFunctions(scope, functionOptionsSchema.parse(isFunctionRead(input.options.operation) ? input.options : { ...input.options, operationId: input.operationId })) }
    if (input.kind === 'job') return { ok: true, data: await runAuthorizedJobs(scope, jobsRequestSchema.parse({ ...input.options, operationId: input.operationId, projectId: input.projectId, expectedRef: input.expectedRef, deviceSecret: 'owner-session-internal' })) }
    return { ok: true, data: await runTrackedAuthOperation(scope, input.options, input.operationId) }
  } catch (error) { return { ok: false, error: explanation(error) } }
}

export async function prepareDataEdit(raw: unknown): Promise<AdministrationResult> {
  try {
    const input = dataEditorInputSchema.parse(raw)
    const key: unknown = JSON.parse(input.keyText)
    const values: unknown = input.type === 'delete' ? undefined : JSON.parse(input.valuesText)
    const action = mutationActionSchema.parse({ type: input.type, table: input.table, rows: [{ key, ...(values === undefined ? {} : { values }) }] })
    return administerProjectBackend({ projectId: input.projectId, expectedRef: input.expectedRef, operationId: randomUUID(), kind: 'data', options: { operation: 'data-plan', environment: 'development', action } })
  } catch (error) { return { ok: false, error: error instanceof MutationError ? error.message : 'Chave e valores precisam conter campos válidos em JSON. Nenhum dado foi alterado.' } }
}

export async function prepareDataImport(raw: unknown): Promise<AdministrationResult> {
  try {
    const input = dataImportInputSchema.parse(raw)
    const rows: unknown = JSON.parse(input.rowsText)
    const action = mutationActionSchema.parse({ type: input.type, table: input.table, rows })
    return administerProjectBackend({ projectId: input.projectId, expectedRef: input.expectedRef, operationId: randomUUID(), kind: 'data', options: { operation: 'data-plan', environment: 'development', action } })
  } catch (error) { return { ok: false, error: error instanceof MutationError ? error.message : 'Informe até 25 registros com chave e valores válidos. Nenhum dado foi alterado.' } }
}
