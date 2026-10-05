import { describe, expect, it, vi } from 'vitest'
import { capabilities, policyInputSchema, type OperationPolicy, type OperationReceipt } from './contract'
import { assertSamePolicy, enforceOperationPolicy } from './policy'
import { runTrackedOperation, type OperationPort } from './service'
import { engineCatalog } from './catalog'
import { capabilityLabels, operationStateLabels } from './presentation'

const scope = { ownerId: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222', environment: 'development' as const }
const policy: OperationPolicy = { ...scope, id: '33333333-3333-4333-8333-333333333333', revision: '44444444-4444-4444-8444-444444444444', enabled: true, capabilities: ['data.update'], resources: [], deviceIds: [], maxRows: 25, maxOperationsPerHour: 60 }
describe('project automation authority', () => {
  it('scopes invitations to a canonical exact email without expanding other resource syntax', () => {
    const input = { projectId: scope.projectId, environment: scope.environment, expectedRevision: null, enabled: true, capabilities: ['auth.invite'], resources: ['auth.invite:User+test@Example.com'], deviceIds: [], maxRows: 1, maxOperationsPerHour: 5 }
    const parsed = policyInputSchema.parse(input)
    expect(parsed.resources).toEqual(['auth.invite:user+test@example.com'])
    const invitations: OperationPolicy = { ...policy, ...parsed }
    expect(() => enforceOperationPolicy(invitations, scope, 'auth.invite', { rows: 1, resource: 'auth.invite:user+test@example.com' })).not.toThrow()
    expect(() => enforceOperationPolicy(invitations, scope, 'auth.invite', { rows: 1, resource: 'auth.invite:another@example.com' })).toThrow('recurso')
    for (const resource of ['auth.invite:invalid', 'auth.invite:user@example.com\r\nBcc:other@example.com', 'public.table+unsafe']) expect(policyInputSchema.safeParse({ ...input, resources: [resource] }).success).toBe(false)
  })
  it('permits only the exact owner, project, environment and capability', () => {
    expect(enforceOperationPolicy(policy, scope, 'data.update', { rows: 25 })).toEqual({ policyId: policy.id, revision: policy.revision })
    for (const other of [{ ...scope, ownerId: 'other' }, { ...scope, projectId: 'other' }, { ...scope, environment: 'production' as const }]) expect(() => enforceOperationPolicy(policy, other, 'data.update')).toThrow('Autorize')
    expect(() => enforceOperationPolicy(null, scope, 'data.update')).toThrow('Autorize')
    expect(() => enforceOperationPolicy({ ...policy, enabled: false }, scope, 'data.update')).toThrow('Autorize')
    expect(() => enforceOperationPolicy(policy, scope, 'auth.roles')).toThrow('não permite')
  })
  it('enforces row, resource and device limits without substring matching', () => {
    for (const rows of [-1, NaN, 25.5, 26]) expect(() => enforceOperationPolicy(policy, scope, 'data.update', { rows })).toThrow('limite')
    const constrained = { ...policy, resources: ['public.tasks'], deviceIds: [scope.ownerId] }
    expect(() => enforceOperationPolicy(constrained, scope, 'data.update', { resource: 'public.tasks' })).toThrow('dispositivo')
    expect(() => enforceOperationPolicy(constrained, { ...scope, deviceId: 'other' }, 'data.update')).toThrow('dispositivo')
    expect(enforceOperationPolicy(constrained, { ...scope, ownerSession: true }, 'data.update', { resource: 'public.tasks' })).toEqual({ policyId: policy.id, revision: policy.revision })
    for (const resource of [undefined, 'public.tasksevil']) expect(() => enforceOperationPolicy(constrained, { ...scope, deviceId: scope.ownerId }, 'data.update', resource ? { resource } : {})).toThrow('recurso')
    expect(enforceOperationPolicy(constrained, { ...scope, deviceId: scope.ownerId }, 'data.update', { resource: 'public.tasks' })).toHaveProperty('revision')
  })
  it('invalidates a prepared grant on any revision or identity change', () => {
    const grant = { policyId: policy.id, revision: policy.revision }
    expect(() => assertSamePolicy(grant, grant)).not.toThrow()
    expect(() => assertSamePolicy(grant, { ...grant, revision: 'new' })).toThrow('mudou')
    expect(() => assertSamePolicy(grant, { ...grant, policyId: 'new' })).toThrow('mudou')
  })
  it('rejects forged policy fields, duplicates and unbounded budgets', () => {
    const { id: _id, revision: _revision, ownerId: _owner, ...input } = policy; void _id; void _revision; void _owner
    const raw = { ...input, expectedRevision: null }
    expect(policyInputSchema.safeParse(raw).success).toBe(true)
    for (const delta of [{ ownerId: scope.ownerId }, { capabilities: ['admin.all'] }, { maxRows: 0 }, { maxOperationsPerHour: 1001 }, { capabilities: ['data.read', 'data.read'] }]) expect(policyInputSchema.safeParse({ ...raw, ...delta }).success).toBe(false)
    expect(Object.keys(capabilityLabels).sort()).toEqual([...capabilities].sort())
    expect(engineCatalog().operations.every(operation => operation.executor && operation.verification)).toBe(true)
    expect(operationStateLabels.uncertain).toContain('confirmar')
  })
})

const receipt: OperationReceipt = { id: policy.id, capability: 'data.update', environment: 'development', state: 'queued', updatedAt: new Date().toISOString(), message: 'registered', result: null }
function port(): OperationPort {
  return { authorize: vi.fn(async () => ({ policyId: policy.id, revision: policy.revision })),
    claim: vi.fn(async () => ({ acquired: true, receipt, token: 'lease' })),
    update: vi.fn(async (_id, _token, state, message, result) => ({ ...receipt, state, message, result: result ?? null })),
    execute: vi.fn(async () => ({ verified: true })), verify: vi.fn(async () => true) }
}
describe('durable backend receipts', () => {
  it('records intent and verifies the result before reporting success', async () => {
    const p = port(); const result = await runTrackedOperation(p)
    expect(result).toMatchObject({ state: 'succeeded', result: { verified: true } })
    expect(p.update).toHaveBeenNthCalledWith(1, receipt.id, 'lease', 'running', expect.any(String))
    expect(p.update).toHaveBeenNthCalledWith(2, receipt.id, 'lease', 'verifying', expect.any(String))
    expect(p.execute).toHaveBeenCalledOnce()
  })
  it.each(['succeeded', 'uncertain', 'running', 'failed'] as const)('never dispatches again for an existing %s receipt', async state => {
    const p = port(); vi.mocked(p.claim).mockResolvedValue({ acquired: false, token: 'old', receipt: { ...receipt, state } })
    expect((await runTrackedOperation(p)).state).toBe(state); expect(p.execute).not.toHaveBeenCalled()
  })
  it('does not send when policy was revoked between claim and dispatch', async () => {
    const p = port(); vi.mocked(p.authorize).mockResolvedValueOnce({ policyId: policy.id, revision: policy.revision }).mockRejectedValueOnce(new Error('revoked'))
    expect((await runTrackedOperation(p)).state).toBe('failed'); expect(p.execute).not.toHaveBeenCalled()
  })
  it('keeps a lost effect response uncertain and never echoes provider errors', async () => {
    const p = port(); vi.mocked(p.execute).mockRejectedValue(new Error('Authorization: private-secret'))
    const result = await runTrackedOperation(p); expect(result.state).toBe('uncertain'); expect(JSON.stringify(result)).not.toContain('private-secret')
    expect(p.execute).toHaveBeenCalledOnce()
  })
  it('keeps unverified results uncertain', async () => {
    const p = port(); vi.mocked(p.verify).mockResolvedValue(false)
    expect((await runTrackedOperation(p)).state).toBe('uncertain')
  })
  it.each(['execute', 'verify'] as const)('does not report success when authority changes during %s', async stage => {
    const p = port()
    if (stage === 'execute') vi.mocked(p.execute).mockImplementation(async () => { vi.mocked(p.authorize).mockRejectedValue(new Error('revoked')); return { verified: true } })
    else vi.mocked(p.verify).mockImplementation(async () => { vi.mocked(p.authorize).mockResolvedValue({ policyId: policy.id, revision: 'changed' }); return true })
    const result = await runTrackedOperation(p)
    expect(result.state).toBe('uncertain')
    expect(p.update).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'succeeded', expect.anything(), expect.anything())
  })
  it('never invents a receipt when persistence is unavailable', async () => {
    const p = port(); vi.mocked(p.claim).mockRejectedValue(new Error('offline'))
    await expect(runTrackedOperation(p)).rejects.toThrow('offline'); expect(p.execute).not.toHaveBeenCalled()
  })
})
