import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { encryptToken, decryptToken } from '../crypto'
import {
  buildDeleteCatalogQuery,
  buildDeleteInspection,
  buildDeleteApply,
  deleteCatalogSchema,
  deleteSnapshotSchema,
  validateDeleteCatalog,
} from '../database-delete/sql'
import {
  mutationActionSchema,
  mutationOptionsSchema,
  MutationError,
  type MutationAction,
  type MutationCapability,
  type MutationOptions,
} from './contract'
import {
  mutationCatalogQuery,
  mutationCatalogSchema,
  mutationInspectionSql,
  mutationSnapshotSchema,
  mutationApplySql,
} from './sql'

const scopeSchema = z
  .object({
    ownerId: z.string().uuid(),
    projectId: z.string().uuid(),
    accountId: z.string().uuid(),
    projectRef: z.string().regex(/^[a-z0-9_-]{1,64}$/),
    environment: z.literal('development'),
    policyId: z.string().min(1),
    revision: z.string().min(1),
  })
  .strict()
export type MutationScope = z.infer<typeof scopeSchema>
const evidenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('write'),
      catalog: mutationCatalogSchema,
      snapshot: mutationSnapshotSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('delete'),
      catalog: deleteCatalogSchema,
      snapshot: deleteSnapshotSchema,
    })
    .strict(),
])
const planSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    scope: scopeSchema,
    createdAt: z.number().int(),
    expiresAt: z.number().int(),
    action: mutationActionSchema,
    evidence: evidenceSchema,
  })
  .strict()
const ttl = 15 * 60 * 1000
/** Internal metadata for the receipt/approval ledger; never return this descriptor to a device.
 * runDataMutation still checks owner, revision, expiry and current state. */
export function describeMutationPlan(planToken: string) {
  let plan: z.infer<typeof planSchema>
  try {
    plan = planSchema.parse(JSON.parse(decryptToken(planToken)))
  } catch {
    throw new MutationError('Plano inválido ou adulterado.', 400)
  }
  return {
    planId: plan.id,
    reviewAction: plan.action,
    capability: `data.${plan.action.type}` as MutationCapability,
    effects: {
      rows: plan.action.rows.length,
      resource: `public.${plan.action.table}`,
    },
    scope: plan.scope,
    expiresAt: plan.expiresAt,
  }
}
export interface MutationDependencies {
  authorize(
    capability: MutationCapability,
    effects: { rows: number; resource: string },
  ): Promise<MutationScope>
  provider: { query(sql: string, readOnly: boolean): Promise<unknown> }
  /** Must atomically consume planId in durable storage. Duplicates fail closed. */
  audit(event: {
    event: 'prepared' | 'claimed' | 'completed' | 'uncertain'
    planId: string
    metadata: Record<string, unknown>
  }): Promise<void>
  now?(): number
  id?(): string
}
export interface MutationResult {
  operation: MutationOptions['operation']
  projectId: string
  projectRef: string
  environment: 'development'
  observedAt: string
  readOnly: boolean
  data: {
    planId: string
    type: MutationAction['type']
    table: string
    impactCount: number
    planToken?: string
    expiresAt?: string
    affectedCount?: number
    verified: boolean
    policyId: string
    revision: string
  }
}
const targets = (action: MutationAction) =>
  action.rows.map((row) => ({ table: action.table, key: row.key }))
export async function runDataMutation(
  deps: MutationDependencies,
  raw: MutationOptions,
): Promise<MutationResult> {
  const options = mutationOptionsSchema.parse(raw),
    now = deps.now ?? Date.now
  let saved: z.infer<typeof planSchema> | undefined
  if (options.operation === 'data-apply') {
    try {
      saved = planSchema.parse(JSON.parse(decryptToken(options.planToken)))
    } catch {
      throw new MutationError('Plano inválido ou adulterado.', 400)
    }
    if (
      saved.createdAt > now() ||
      saved.expiresAt <= now() ||
      saved.expiresAt - saved.createdAt !== ttl
    )
      throw new MutationError('Plano expirado; prepare outro.')
  }
  const action =
    options.operation === 'data-plan' ? options.action : saved!.action
  const capability: MutationCapability = `data.${action.type}`
  const effects = {
    rows: action.rows.length,
    resource: `public.${action.table}`,
  }
  const scope = scopeSchema.parse(await deps.authorize(capability, effects))
  const verify = async () => {
    if (
      JSON.stringify(scope) !==
      JSON.stringify(
        scopeSchema.parse(await deps.authorize(capability, effects)),
      )
    )
      throw new MutationError(
        'Autorização, vínculo ou revisão da política mudou; prepare outro plano.',
        403,
      )
  }
  if (saved && JSON.stringify(saved.scope) !== JSON.stringify(scope))
    throw new MutationError(
      'Plano pertence a outro escopo ou revisão de autorização.',
      403,
    )
  const base = {
    operation: options.operation,
    projectId: scope.projectId,
    projectRef: scope.projectRef,
    environment: scope.environment,
    observedAt: new Date(now()).toISOString(),
    readOnly: options.operation === 'data-plan',
  }
  const details = {
    type: action.type,
    table: action.table,
    impactCount: action.rows.length,
    policyId: scope.policyId,
    revision: scope.revision,
  }
  if (options.operation === 'data-plan') {
    let evidence: z.infer<typeof evidenceSchema>
    await verify()
    if (action.type === 'delete') {
      const [{ catalog }] = z
        .tuple([z.object({ catalog: deleteCatalogSchema })])
        .parse(
          await deps.provider.query(
            buildDeleteCatalogQuery(targets(action)),
            true,
          ),
        )
      validateDeleteCatalog(targets(action), catalog)
      await verify()
      const [{ snapshot }] = z
        .tuple([z.object({ snapshot: deleteSnapshotSchema })])
        .parse(
          await deps.provider.query(
            buildDeleteInspection(targets(action), catalog),
            true,
          ),
        )
      if (
        !snapshot.ready ||
        snapshot.impactCount !== action.rows.length ||
        snapshot.undeclaredDependencies
      )
        throw new MutationError(
          'Inclua todas as linhas dependentes autorizadas. Nada foi alterado.',
        )
      evidence = { kind: 'delete', catalog, snapshot }
    } else {
      const [{ catalog }] = z
        .tuple([z.object({ catalog: mutationCatalogSchema })])
        .parse(
          await deps.provider.query(mutationCatalogQuery(action.table), true),
        )
      const sql = mutationInspectionSql(action, catalog)
      await verify()
      const [{ snapshot }] = z
        .tuple([z.object({ snapshot: mutationSnapshotSchema })])
        .parse(await deps.provider.query(sql, true))
      if (!snapshot.ready)
        throw new MutationError(
          'As chaves ou o estado das linhas não correspondem à operação solicitada.',
        )
      evidence = { kind: 'write', catalog, snapshot }
    }
    await verify()
    const createdAt = now(),
      expiresAt = createdAt + ttl,
      id = (deps.id ?? randomUUID)()
    const plan = planSchema.parse({
      version: 1,
      id,
      scope,
      createdAt,
      expiresAt,
      action,
      evidence,
    })
    const planToken = encryptToken(JSON.stringify(plan))
    if (planToken.length > 500000)
      throw new MutationError('Plano excede o limite de tamanho.')
    await deps.audit({
      event: 'prepared',
      planId: id,
      metadata: {
        ...details,
        expiresAt: new Date(expiresAt).toISOString(),
        targetRef: scope.projectRef,
      },
    })
    return {
      ...base,
      data: {
        ...details,
        planId: id,
        planToken,
        expiresAt: new Date(expiresAt).toISOString(),
        verified: false,
      },
    }
  }
  const plan = saved!
  if ((action.type === 'delete') !== (plan.evidence.kind === 'delete'))
    throw new MutationError('Plano incompatível com a operação.', 400)
  const sql =
    plan.evidence.kind === 'delete'
      ? buildDeleteApply(
          targets(action),
          plan.evidence.catalog,
          plan.evidence.snapshot,
        )
      : mutationApplySql(action, plan.evidence.catalog, plan.evidence.snapshot)
  await verify()
  await deps.audit({
    event: 'claimed',
    planId: plan.id,
    metadata: { ...details, targetRef: scope.projectRef },
  })
  try {
    await verify()
    if (now() >= plan.expiresAt)
      throw new MutationError('Plano expirou antes da execução.')
    const countField =
      action.type === 'delete' ? 'deletedCount' : 'affectedCount'
    const [result] = z
      .tuple([z.record(z.string(), z.unknown())])
      .parse(await deps.provider.query(sql, false))
    if (result[countField] !== action.rows.length)
      throw new MutationError('Contagem final não confirmada.', 502)
    await verify()
    await deps.audit({
      event: 'completed',
      planId: plan.id,
      metadata: {
        ...details,
        affectedCount: action.rows.length,
        targetRef: scope.projectRef,
      },
    })
    return {
      ...base,
      observedAt: new Date(now()).toISOString(),
      data: {
        ...details,
        planId: plan.id,
        affectedCount: action.rows.length,
        verified: true,
      },
    }
  } catch {
    try {
      await deps.audit({
        event: 'uncertain',
        planId: plan.id,
        metadata: { ...details, targetRef: scope.projectRef },
      })
    } catch {
      throw new MutationError(
        'Resultado e auditoria não confirmados. O plano foi consumido; consulte o banco antes de outro plano.',
        503,
      )
    }
    throw new MutationError(
      'Resultado não confirmado. O plano foi consumido e não será repetido; consulte os registros.',
      502,
    )
  }
}
