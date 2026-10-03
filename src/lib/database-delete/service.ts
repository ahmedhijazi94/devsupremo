import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { encryptToken, decryptToken } from '../crypto'
import { DataDeleteError, deleteOptionsSchema, deleteResponseSchema, deleteTargetsSchema, type DeleteOptions, type DeleteResponse } from './contract'
import { buildDeleteCatalogQuery, buildDeleteInspection, buildDeleteApply, deleteCatalogSchema, deleteSnapshotSchema, validateDeleteCatalog } from './sql'
import type { DeleteProvider } from './provider'

const planScopeSchema = z.object({ ownerId: z.string().uuid(), projectId: z.string().uuid(), accountId: z.string().uuid(),
  projectRef: z.string().regex(/^[a-z0-9_-]{1,64}$/), environment: z.literal('development') }).strict()
export type DeleteScope = z.infer<typeof planScopeSchema>
const planSchema = z.object({ version: z.literal(1), id: z.string().uuid(), scope: planScopeSchema,
  createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
  targets: deleteTargetsSchema, catalog: deleteCatalogSchema, snapshot: deleteSnapshotSchema }).strict()
const ttl = 15 * 60 * 1000
export type DeleteAudit = { event: 'prepared' | 'claimed' | 'completed' | 'unconfirmed'; planId: string;
  metadata: Record<string, unknown> }
export interface DeleteDependencies {
  provider: DeleteProvider
  /** Every call must verify the live identity, ownership, account and development binding. */
  authorize(): Promise<DeleteScope>
  /** claimed inserts planId as an immutable unique PK; duplicates MUST fail closed. */
  audit(event: DeleteAudit): Promise<void>
  now?(): number
  id?(): string
}
const scopeMatches = (a: DeleteScope, b: DeleteScope): boolean =>
  a.ownerId === b.ownerId && a.projectId === b.projectId && a.accountId === b.accountId && a.projectRef === b.projectRef && a.environment === b.environment

export async function runDataDelete(deps: DeleteDependencies, raw: DeleteOptions): Promise<DeleteResponse> {
  const options = deleteOptionsSchema.parse(raw)
  const now = deps.now ?? Date.now
  const scope = planScopeSchema.parse(await deps.authorize())
  const verify = async (): Promise<void> => {
    if (!scopeMatches(scope, planScopeSchema.parse(await deps.authorize()))) throw new DataDeleteError('O vínculo ou a identidade mudou. Prepare outro plano.')
  }
  const envelope = { projectId: scope.projectId, projectRef: scope.projectRef, environment: scope.environment, observedAt: new Date(now()).toISOString() }
  if (options.operation === 'data-delete-plan') {
    const [{ catalog }] = z.tuple([z.object({ catalog: deleteCatalogSchema })]).parse(await deps.provider.query(buildDeleteCatalogQuery(options.targets), true))
    validateDeleteCatalog(options.targets, catalog)
    await verify()
    const [{ snapshot }] = z.tuple([z.object({ snapshot: deleteSnapshotSchema })]).parse(await deps.provider.query(buildDeleteInspection(options.targets, catalog), true))
    if (!snapshot.ready || snapshot.impactCount !== options.targets.length || snapshot.undeclaredDependencies !== 0)
      throw new DataDeleteError('Plano não executável: confira as chaves primárias e inclua explicitamente os registros dependentes autorizados. Nada foi excluído.')
    await verify()
    const createdAt = now(), expiresAt = createdAt + ttl, id = (deps.id ?? randomUUID)()
    const plan = planSchema.parse({ version: 1, id, scope, createdAt, expiresAt, targets: options.targets, catalog, snapshot })
    const planToken = encryptToken(JSON.stringify(plan))
    if (planToken.length > 500_000) throw new DataDeleteError('Plano excede o limite; reduza os registros envolvidos.')
    await deps.audit({ event: 'prepared', planId: id, metadata: { targetRef: scope.projectRef, environment: scope.environment,
      impactCount: snapshot.impactCount, tables: [...new Set(options.targets.map(target => target.table))], expiresAt: new Date(expiresAt).toISOString() } })
    return deleteResponseSchema.parse({ ...envelope, operation: options.operation, readOnly: true,
      data: { planId: id, planToken, targets: options.targets, impactCount: snapshot.impactCount, expiresAt: new Date(expiresAt).toISOString() } })
  }
  let plan: z.infer<typeof planSchema>
  try { plan = planSchema.parse(JSON.parse(decryptToken(options.planToken))) }
  catch { throw new DataDeleteError('Plano inválido ou adulterado. Prepare outro plano.', 400) }
  const timestamp = now()
  if (plan.createdAt > timestamp || plan.expiresAt <= timestamp || plan.expiresAt - plan.createdAt !== ttl)
    throw new DataDeleteError('Plano expirado. Confira os dados e prepare outro plano.')
  if (!scopeMatches(scope, plan.scope)) throw new DataDeleteError('O plano pertence a outro dono, projeto, conta ou ambiente.', 403)
  // Revalidate the server-produced plan even after authenticated decryption.
  validateDeleteCatalog(plan.targets, plan.catalog)
  if (!plan.snapshot.ready || plan.snapshot.impactCount !== plan.targets.length || plan.snapshot.undeclaredDependencies !== 0)
    throw new DataDeleteError('Plano não executável. Prepare outro plano.')
  const sql = buildDeleteApply(plan.targets, plan.catalog, plan.snapshot)
  await verify()
  await deps.audit({ event: 'claimed', planId: plan.id, metadata: { targetRef: scope.projectRef, environment: scope.environment,
    impactCount: plan.snapshot.impactCount, authorizationDigest: createHash('sha256').update(options.authorization).digest('hex') } })
  try {
    await verify()
    if (now() >= plan.expiresAt) throw new DataDeleteError('Plano expirou antes da execução. Prepare outro plano.')
    const [{ deletedCount }] = z.tuple([z.object({ deletedCount: z.literal(plan.targets.length) })]).parse(await deps.provider.query(sql, false))
    await verify()
    await deps.audit({ event: 'completed', planId: plan.id, metadata: { deletedCount, targetRef: scope.projectRef, environment: scope.environment } })
    return deleteResponseSchema.parse({ ...envelope, observedAt: new Date(now()).toISOString(), operation: options.operation, readOnly: false,
      data: { planId: plan.id, deletedCount, verified: true } })
  } catch (error) {
    try { await deps.audit({ event: 'unconfirmed', planId: plan.id, metadata: { targetRef: scope.projectRef, environment: scope.environment } }) }
    catch { throw new DataDeleteError('Resultado e registro final não confirmados. O plano foi consumido; consulte os registros antes de preparar outro.', 503) }
    if (error instanceof DataDeleteError) throw error
    throw new DataDeleteError('Resultado da exclusão não confirmado. O plano foi consumido e não será repetido; consulte os registros antes de preparar outro.', 502)
  }
}
