import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mutationOptionsSchema, type MutationAction } from './contract'
import {
  mutationApplySql,
  mutationInspectionSql,
  validateMutationCatalog,
  type MutationCatalog,
} from './sql'
import { runDataMutation, type MutationDependencies } from './service'

const id = '11111111-1111-4111-8111-111111111111'
const action: MutationAction = {
  type: 'update',
  table: 'notes',
  rows: [{ key: { id }, values: { title: 'Updated' } }],
}
export const catalogFixture = (): MutationCatalog => ({
  oid: 1,
  table: 'notes',
  kind: 'r',
  rls: true,
  ordinary: true,
  columns: [
    {
      name: 'id',
      type: 'uuid',
      schema: 'pg_catalog',
      kind: 'b',
      generated: '',
      safeOutput: true,
      defaultSql: null,
      collation: null,
    },
    {
      name: 'title',
      type: 'text',
      schema: 'pg_catalog',
      kind: 'b',
      generated: '',
      safeOutput: true,
      defaultSql: null,
      collation: 'pg_catalog',
    },
    {
      name: 'state',
      type: 'status',
      schema: 'public',
      kind: 'e',
      generated: '',
      safeOutput: true,
      defaultSql: null,
      collation: null,
    },
  ],
  primaryKey: ['id'],
  primaryKeyImmediate: true,
  foreignKeyColumns: [],
  checks: [],
  indexes: [],
  triggers: [],
  rules: [],
  dependenciesSafe: true,
})
const snapshot = {
  catalogFingerprint: 'a'.repeat(64),
  rows: [{ index: 0, count: 1, fingerprint: 'b'.repeat(64) }],
  ready: true,
}
const scope = {
  ownerId: id,
  projectId: id,
  accountId: id,
  projectRef: 'fixture',
  environment: 'development' as const,
  policyId: id,
  revision: id,
}
function ports(): MutationDependencies {
  return {
    authorize: vi.fn(async () => scope),
    provider: {
      query: vi
        .fn()
        .mockResolvedValueOnce([{ catalog: catalogFixture() }])
        .mockResolvedValueOnce([{ snapshot }])
        .mockResolvedValue([{ affectedCount: 1 }]),
    },
    audit: vi.fn(async () => undefined),
    now: () => 1000,
    id: () => id,
  }
}
beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32))
})
describe('planned data mutation boundary', () => {
  it('rejects raw SQL, production, incomplete requests and protected values', () => {
    expect(
      mutationOptionsSchema.safeParse({
        operation: 'data-plan',
        environment: 'production',
        action,
      }).success,
    ).toBe(false)
    expect(
      mutationOptionsSchema.safeParse({
        operation: 'data-plan',
        environment: 'development',
        action,
        sql: 'DELETE FROM notes',
      }).success,
    ).toBe(false)
    expect(
      mutationOptionsSchema.safeParse({
        operation: 'data-plan',
        environment: 'development',
        action: {
          ...action,
          rows: [{ key: { id }, values: { role: 'master' } }],
        },
      }).success,
    ).toBe(false)
  })
  it('permits preserving an enum but refuses changing it through an unsupported cast or changing a key', () => {
    expect(
      validateMutationCatalog(action, catalogFixture()).columns,
    ).toHaveLength(3)
    for (const values of [
      { state: 'draft' },
      { id: 'other' },
      { missing: 'x' },
    ])
      expect(() =>
        validateMutationCatalog(
          { ...action, rows: [{ key: { id }, values }] },
          catalogFixture(),
        ),
      ).toThrow()
    expect(() =>
      validateMutationCatalog(
        { ...action, rows: [{ key: { title: 'x' }, values: { title: 'y' } }] },
        catalogFixture(),
      ),
    ).toThrow()
    expect(() =>
      validateMutationCatalog(
        { ...action, rows: [action.rows[0]!, action.rows[0]!] },
        catalogFixture(),
      ),
    ).toThrow()
  })
  it('rejects side effects and altered ownership instead of weakening RLS', () => {
    for (const patch of [
      { rls: false },
      { ordinary: false },
      { rules: ['danger'] },
      { dependenciesSafe: false },
      { columns: [{ ...catalogFixture().columns[0]!, safeOutput: false }] },
    ])
      expect(() =>
        validateMutationCatalog(action, { ...catalogFixture(), ...patch }),
      ).toThrow()
    const fk = { ...catalogFixture(), foreignKeyColumns: ['title'] }
    expect(() => validateMutationCatalog(action, fk)).toThrow(/vínculos/)
  })
  it('generates locked compare-and-write SQL with encoded values and exact keys', () => {
    const dangerous = {
      ...action,
      rows: [
        {
          key: { id },
          values: {
            title: "x'; END $supremo_mutation$; DELETE FROM notes; --",
          },
        },
      ],
    }
    const sql = mutationApplySql(dangerous, catalogFixture(), snapshot)
    expect(sql).toContain('ACCESS EXCLUSIVE')
    expect(sql).toContain('SUPREMO_MUTATION_CHANGED')
    expect(sql).not.toContain(dangerous.rows[0]!.values.title)
    expect(mutationInspectionSql(action, catalogFixture())).toContain(
      'fingerprint',
    )
    expect(() =>
      mutationApplySql(action, catalogFixture(), { ...snapshot, ready: false }),
    ).toThrow()
  })
  it('prepares no writes, then consumes a policy-bound plan before executing once', async () => {
    const deps = ports(),
      plan = await runDataMutation(deps, {
        operation: 'data-plan',
        environment: 'development',
        action,
      })
    expect(plan.data.verified).toBe(false)
    expect(deps.provider.query).toHaveBeenCalledTimes(2)
    const done = await runDataMutation(deps, {
      operation: 'data-apply',
      environment: 'development',
      planToken: plan.data.planToken!,
    })
    expect(done.data).toMatchObject({
      affectedCount: 1,
      verified: true,
      revision: id,
    })
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'claimed', planId: id }),
    )
  })
  it('blocks cross-owner, changed policy, expiry, forged tokens and claim failure before write', async () => {
    const deps = ports(),
      plan = await runDataMutation(deps, {
        operation: 'data-plan',
        environment: 'development',
        action,
      })
    const apply = {
      operation: 'data-apply' as const,
      environment: 'development' as const,
      planToken: plan.data.planToken!,
    }
    for (const changed of [
      { ...scope, revision: 'changed' },
      { ...scope, accountId: '22222222-2222-4222-8222-222222222222' },
    ])
      await expect(
        runDataMutation({ ...deps, authorize: async () => changed }, apply),
      ).rejects.toThrow(/escopo/)
    await expect(
      runDataMutation({ ...deps, now: () => 901001 }, apply),
    ).rejects.toThrow(/expirado/)
    await expect(
      runDataMutation(deps, { ...apply, planToken: 'x'.repeat(64) }),
    ).rejects.toThrow(/adulterado/)
    await expect(
      runDataMutation(
        {
          ...deps,
          audit: async () => {
            throw new Error('already consumed')
          },
        },
        apply,
      ),
    ).rejects.toThrow(/consumed/)
    expect(deps.provider.query).toHaveBeenCalledTimes(2)
  })
  it('does not repeat a lost write response or claim success after failed final audit', async () => {
    const deps = ports(),
      plan = await runDataMutation(deps, {
        operation: 'data-plan',
        environment: 'development',
        action,
      })
    deps.provider.query = vi.fn(async () => {
      throw new Error('timeout')
    })
    await expect(
      runDataMutation(deps, {
        operation: 'data-apply',
        environment: 'development',
        planToken: plan.data.planToken!,
      }),
    ).rejects.toThrow(/consumido/)
    expect(deps.provider.query).toHaveBeenCalledTimes(1)
    expect(deps.audit).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: 'uncertain' }),
    )
  })
})
