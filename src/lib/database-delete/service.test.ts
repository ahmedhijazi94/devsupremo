import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptToken, encryptToken } from '../crypto'
import { runDataDelete, type DeleteAudit, type DeleteDependencies, type DeleteScope } from './service'
import { type DeleteCatalog, type DeleteSnapshot } from './sql'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const scope: DeleteScope = { ownerId: uuid(1), projectId: uuid(2), accountId: uuid(3), projectRef: 'dev-ref', environment: 'development' }
const catalog: DeleteCatalog = { version: 1, foreignKeys: [], tables: [{ oid: 1, schema: 'public', name: 'orgs', kind: 'r', rls: true,
  partition: false, inherits: false, accessMethod: 'heap', columns: [{ name: 'id', type: 'uuid', typeSchema: 'pg_catalog', kind: 'b', generated: '', collationSchema: null }],
  indirectSideEffects: false, primaryKey: ['id'], primaryKeyImmediate: true, indexesSafe: true, indexes: [], deleteTriggers: [], deleteRules: [] }] }
const snapshot: DeleteSnapshot = { catalogFingerprint: 'a'.repeat(64), rows: [{ index: 0, count: 1, fingerprint: 'b'.repeat(64) }], impactCount: 1, undeclaredDependencies: 0, ready: true }
const options = { operation: 'data-delete-plan' as const, environment: 'development' as const, targets: [{ table: 'orgs', key: { id: uuid(4) } }] }
let time: number
let sequence: number
let deps: DeleteDependencies
let claims: Set<string>
const query = vi.fn(), audit = vi.fn(), authorize = vi.fn()
beforeEach(() => {
  vi.clearAllMocks(); time = 1_800_000_000_000; sequence = 10; claims = new Set()
  query.mockImplementation(async (_sql: string, readOnly: boolean) => readOnly ? _sql.includes('AS snapshot') ? [{ snapshot }] : [{ catalog }] : [{ deletedCount: 1 }])
  authorize.mockResolvedValue(scope)
  audit.mockImplementation(async (event: DeleteAudit) => {
    if (event.event === 'claimed') {
      if (claims.has(event.planId)) throw new Error('already consumed')
      claims.add(event.planId)
    }
  })
  deps = { provider: { query }, audit, authorize, now: () => time, id: () => uuid(sequence++) }
})
async function prepare() {
  const result = await runDataDelete(deps, options)
  if (result.operation !== 'data-delete-plan') throw new Error('missing plan')
  return result.data
}
const apply = (planToken: string) => runDataDelete(deps, { operation: 'data-delete-apply', environment: 'development', planToken, authorization: 'Remove the company I explicitly selected; preserve my account.' })

describe('reviewed deletion lifecycle', () => {
  it('prepares a private, expiring plan without deleting data, then consumes and audits before verified execution', async () => {
    const plan = await prepare()
    expect(plan).toMatchObject({ targets: options.targets, impactCount: 1, expiresAt: new Date(time + 900_000).toISOString() })
    expect(plan.planToken).not.toContain(uuid(4))
    expect(query.mock.calls.every(call => call[1] === true)).toBe(true)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'prepared' }))
    const result = await apply(plan.planToken)
    expect(result).toMatchObject({ readOnly: false, data: { planId: plan.planId, deletedCount: 1, verified: true } })
    const claim = audit.mock.calls.findIndex(call => call[0].event === 'claimed')
    expect(audit.mock.invocationCallOrder[claim]).toBeLessThan(query.mock.invocationCallOrder.at(-1)!)
    expect(audit.mock.calls.map(call => call[0].event)).toEqual(['prepared', 'claimed', 'completed'])
    expect(JSON.stringify(audit.mock.calls)).not.toContain('Remove the company')
    expect(JSON.stringify(audit.mock.calls)).not.toContain(plan.planToken)
    await expect(apply(plan.planToken)).rejects.toThrow('consumed')
    expect(query.mock.calls.filter(call => call[1] === false)).toHaveLength(1)
  })
  it('refuses unlisted dependents and missing rows without issuing a plan', async () => {
    query.mockResolvedValueOnce([{ catalog }]).mockResolvedValueOnce([{ snapshot: { ...snapshot, ready: false, undeclaredDependencies: 1 } }])
    await expect(prepare()).rejects.toThrow('dependentes')
    expect(audit).not.toHaveBeenCalled()
    query.mockResolvedValueOnce([{ catalog }]).mockResolvedValueOnce([{ snapshot: { ...snapshot, ready: false, impactCount: 0, rows: [{ index: 0, count: 0, fingerprint: null }] } }])
    await expect(prepare()).rejects.toThrow('chaves')
  })
  it.each(['ownerId', 'projectId', 'accountId', 'projectRef'] as const)('binds the plan to %s', async field => {
    const plan = await prepare(); query.mockClear()
    authorize.mockResolvedValue({ ...scope, [field]: field === 'projectRef' ? 'other-ref' : uuid(99) })
    await expect(apply(plan.planToken)).rejects.toThrow('outro dono')
    expect(query).not.toHaveBeenCalled()
    expect(claims.size).toBe(0)
  })
  it('refuses forged, expired and future-dated plans before consuming them', async () => {
    const plan = await prepare(); query.mockClear()
    const last = plan.planToken.at(-1) === 'a' ? 'b' : 'a'
    await expect(apply(plan.planToken.slice(0, -1) + last)).rejects.toThrow('adulterado')
    time += 900_000
    await expect(apply(plan.planToken)).rejects.toThrow('expirado')
    time -= 900_001
    await expect(apply(plan.planToken)).rejects.toThrow('expirado')
    expect(query).not.toHaveBeenCalled()
  })
  it('reauthorizes before claim and again after claim, before touching data', async () => {
    const plan = await prepare(); query.mockClear()
    authorize.mockResolvedValueOnce(scope).mockResolvedValueOnce({ ...scope, accountId: uuid(99) })
    await expect(apply(plan.planToken)).rejects.toThrow('vínculo')
    expect(claims.size).toBe(0)
    authorize.mockResolvedValueOnce(scope).mockResolvedValueOnce(scope).mockResolvedValueOnce({ ...scope, accountId: uuid(99) })
    await expect(apply(plan.planToken)).rejects.toThrow('vínculo')
    expect(claims.size).toBe(1)
    expect(query).not.toHaveBeenCalled()
  })
  it('does not call provider if audit cannot consume the plan', async () => {
    const plan = await prepare(); query.mockClear(); audit.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(apply(plan.planToken)).rejects.toThrow('audit unavailable')
    expect(query).not.toHaveBeenCalled()
  })
  it.each([new Error('timeout'), null, [{ deletedCount: 0 }], [{ deletedCount: 2 }]])('does not report uncertain writes as success or automatically retry: %j', async outcome => {
    const plan = await prepare(); query.mockClear()
    if (outcome instanceof Error) query.mockRejectedValueOnce(outcome); else query.mockResolvedValueOnce(outcome)
    await expect(apply(plan.planToken)).rejects.toThrow('não confirmado')
    await expect(apply(plan.planToken)).rejects.toThrow('consumed')
    expect(query).toHaveBeenCalledTimes(1)
    expect(audit.mock.calls.map(call => call[0].event)).toContain('unconfirmed')
    expect(audit.mock.calls.map(call => call[0].event)).not.toContain('completed')
  })
  it('does not assert completion if the final audit fails', async () => {
    const plan = await prepare()
    audit.mockImplementation(async (event: DeleteAudit) => { if (event.event !== 'claimed') throw new Error('audit down') })
    await expect(apply(plan.planToken)).rejects.toThrow('registro final não confirmados')
  })
  it('revalidates decoded plan structure and readiness even for trusted encrypted content', async () => {
    const plan = await prepare()
    const decoded = JSON.parse(decryptToken(plan.planToken)) as { snapshot: DeleteSnapshot }
    decoded.snapshot.ready = false
    await expect(apply(encryptToken(JSON.stringify(decoded)))).rejects.toThrow('não executável')
  })
  it('bounds plan size and rechecks identity while preparing', async () => {
    authorize.mockResolvedValueOnce(scope).mockResolvedValueOnce({ ...scope, projectRef: 'other' })
    await expect(prepare()).rejects.toThrow('vínculo')
    expect(audit).not.toHaveBeenCalled()
  })
})
