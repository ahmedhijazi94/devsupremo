import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { drainDurableOperations, enqueueDatabaseOperation, operationStatus, readDurableOperation, resumeDatabaseOperation, waitForDatabaseOperation } from './durable-operations'
import { requestDatabase, startDatabaseWorker } from './database-queue'

let cwd: string
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-durable-')) })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); fs.rmSync(cwd, { recursive: true, force: true }) })
it('returns a durable ID immediately and retains the late result without repeating its effect', async () => {
  const id = enqueueDatabaseOperation(cwd, 'migrate', {})
  expect(await waitForDatabaseOperation(cwd, id, 0)).toMatchObject({ operationId: id, status: 'queued', pending: true })
  const execute = vi.fn(async () => ({ applied: ['one.sql'] }))
  await drainDurableOperations(cwd, execute)
  await drainDurableOperations(cwd, execute)
  expect(await waitForDatabaseOperation(cwd, id, 0)).toEqual({ applied: ['one.sql'] })
  expect(operationStatus(cwd, id)).toMatchObject({ status: 'succeeded', pending: false })
  expect(execute).toHaveBeenCalledTimes(1)
})
it('retries only a receipt read when its worker atomically replaces the file mid-read', () => {
  const id = enqueueDatabaseOperation(cwd, 'status', {})
  const file = path.join(cwd, '.supremo/database-queue/operations', `${id}.json`)
  const replacement = `${file}.test-next`, current = readDurableOperation(cwd, id)
  fs.writeFileSync(replacement, JSON.stringify({ ...current, status: 'succeeded', result: { ready: true } }))
  const originalRead = fs.readSync
  const read = vi.spyOn(fs, 'readSync').mockImplementationOnce((...args: Parameters<typeof fs.readSync>) => {
    const result = originalRead(...args)
    fs.renameSync(replacement, file)
    return result
  })
  expect(operationStatus(cwd, id)).toMatchObject({ status: 'succeeded', result: { ready: true } })
  read.mockRestore()
})
it('never executes a mutation again after a lost response', async () => {
  const id = enqueueDatabaseOperation(cwd, 'anonymous-auth', {})
  const execute = vi.fn(async () => { throw new Error('connection closed after write') })
  await drainDurableOperations(cwd, execute)
  await drainDurableOperations(cwd, execute)
  expect(operationStatus(cwd, id)).toMatchObject({ status: 'uncertain', pending: false })
  expect(execute).toHaveBeenCalledTimes(1)
})
it.each(['receipt', 'operationReceipt', 'data.receipt', 'data.operationReceipt'])('preserves an uncertain HTTP200 %s receipt without replaying the mutation', async placement => {
  const operationId = crypto.randomUUID(), id = enqueueDatabaseOperation(cwd, 'migrate', { operationId })
  const receipt = { id: operationId, state: 'uncertain' }
  const [first, second] = placement.split('.')
  const result = second ? { [first!]: { [second]: receipt } } : { [first!]: receipt }
  const execute = vi.fn(async () => result)
  await drainDurableOperations(cwd, execute)
  await drainDurableOperations(cwd, execute)
  expect(await waitForDatabaseOperation(cwd, id, 0)).toMatchObject({ status: 'uncertain', result, nextAction: expect.stringContaining('não repita') })
  expect(() => resumeDatabaseOperation(cwd, id)).toThrow('Somente recusa')
  expect(execute).toHaveBeenCalledTimes(1)
})
it.each([
  ['succeeded', 'succeeded'], ['failed', 'failed'], ['cancelled', 'failed'],
  ['queued', 'uncertain'], ['running', 'uncertain'], ['verifying', 'uncertain'],
] as const)('maps a server receipt in state %s to local %s', async (state, expected) => {
  const operationId = crypto.randomUUID(), id = enqueueDatabaseOperation(cwd, 'migrate', { operationId })
  await drainDurableOperations(cwd, async () => ({ receipt: { id: operationId, state } }))
  expect(readDurableOperation(cwd, id).status).toBe(expected)
})
it.each([{ state: 'succeeded' }, { id: crypto.randomUUID(), state: 'succeeded' }, { id: crypto.randomUUID(), state: 'unknown-state' }])('does not confirm a malformed or mismatched receipt', async receipt => {
  const id = enqueueDatabaseOperation(cwd, 'migrate', {})
  await drainDurableOperations(cwd, async () => ({ receipt }))
  expect(readDurableOperation(cwd, id).status).toBe('uncertain')
})
it.each([
  ['completed', true, 'succeeded'], ['completed', false, 'uncertain'], ['verifying', false, 'uncertain'],
  ['running', false, 'uncertain'], ['outcome_unknown', false, 'uncertain'], ['failed', false, 'failed'],
] as const)('uses integration evidence for %s/%s instead of its HTTP200 response', async (status, effectVerified, expected) => {
  const operationId = crypto.randomUUID(), id = enqueueDatabaseOperation(cwd, 'backend-integration', {
    options: { operation: 'resend-send-test', operationId, connectionId: crypto.randomUUID(), from: 'sender@example.com', to: 'recipient@example.com' },
  })
  const execute = vi.fn(async () => ({ data: { operationId, status, effectVerified } }))
  await drainDurableOperations(cwd, execute)
  await drainDurableOperations(cwd, execute)
  expect(readDurableOperation(cwd, id).status).toBe(expected)
  expect(execute).toHaveBeenCalledTimes(1)
})
it('does not interpret a queried receipt or application row as the read operation outcome', async () => {
  const remoteId = crypto.randomUUID(), id = enqueueDatabaseOperation(cwd, 'backend-operation-status', { id: remoteId })
  const result = { data: { receipt: { id: remoteId, state: 'uncertain' } } }
  await drainDurableOperations(cwd, async () => result)
  expect(await waitForDatabaseOperation(cwd, id, 0)).toEqual(result)
  expect(readDurableOperation(cwd, id).status).toBe('succeeded')
})
it('distinguishes explicit server refusal from a potentially completed mutation', async () => {
  const id = enqueueDatabaseOperation(cwd, 'anonymous-auth', {})
  await drainDurableOperations(cwd, async () => { throw Object.assign(new Error('Dispositivo revogado'), { definitive: true }) })
  await expect(waitForDatabaseOperation(cwd, id, 0)).rejects.toThrow('Dispositivo revogado')
  expect(readDurableOperation(cwd, id).status).toBe('failed')
})
it('retains an approval refusal and resumes only the original payload and provider ID', async () => {
  const operationId = crypto.randomUUID(), id = enqueueDatabaseOperation(cwd, 'migrate', { operationId })
  const execute = vi.fn(async () => { throw Object.assign(new Error('Aprovação necessária'), { code: 'operation_approval_required', operationId, definitive: true }) })
  await drainDurableOperations(cwd, execute)
  expect(await waitForDatabaseOperation(cwd, id, 0)).toMatchObject({ status: 'needs_authorization', authorizationOperationId: operationId })
  await drainDurableOperations(cwd, execute); expect(execute).toHaveBeenCalledTimes(1)
  expect(resumeDatabaseOperation(cwd, id)).toMatchObject({ status: 'queued', operationId: id })
  expect(() => resumeDatabaseOperation(cwd, id)).toThrow('Somente recusa')
  const success = vi.fn(async () => ({ applied: true }))
  await drainDurableOperations(cwd, success)
  expect(success).toHaveBeenCalledExactlyOnceWith('migrate', { operationId })
  expect(readDurableOperation(cwd, id).status).toBe('succeeded')
})
it('never resumes an uncertain mutation or a mismatched approval operation ID', async () => {
  const id = enqueueDatabaseOperation(cwd, 'migrate', {})
  await drainDurableOperations(cwd, async () => { throw Object.assign(new Error('Mismatched reply'), { code: 'operation_approval_required', operationId: crypto.randomUUID() }) })
  expect(readDurableOperation(cwd, id).status).toBe('uncertain')
  expect(() => resumeDatabaseOperation(cwd, id)).toThrow('Somente recusa')
})
it('binds server-derived approval IDs to the unchanged local contract before resuming', async () => {
  const options = { requestId: crypto.randomUUID(), credentialId: crypto.randomUUID() }
  const id = enqueueDatabaseOperation(cwd, 'secrets-apply', options), operationId = options.requestId
  await drainDurableOperations(cwd, async () => { throw Object.assign(new Error('Approve exact request'), { code: 'operation_approval_required', operationId }) })
  expect(resumeDatabaseOperation(cwd, id)).toMatchObject({ status: 'queued' })
  await drainDurableOperations(cwd, async () => { throw Object.assign(new Error('Approve exact request'), { code: 'operation_approval_required', operationId }) })
  const file = path.join(cwd, '.supremo/database-queue/operations', `${id}.json`), entry = readDurableOperation(cwd, id)
  fs.writeFileSync(file, JSON.stringify({ ...entry, options: { ...options, credentialId: crypto.randomUUID() } }))
  expect(() => resumeDatabaseOperation(cwd, id)).toThrow('Somente recusa')
})
it.each(['data-apply', 'data-delete-apply'] as const)('preserves the opaque %s plan and its server-derived ID through approval', async operation => {
  const options = { environment: 'development' as const, planToken: 'opaque-signed-plan'.repeat(5), ...(operation === 'data-delete-apply' ? { authorization: 'explicit fixture owner request' } : {}) }
  const id = enqueueDatabaseOperation(cwd, operation, options), operationId = crypto.randomUUID()
  await drainDurableOperations(cwd, async () => { throw Object.assign(new Error('Approve plan'), { code: 'operation_approval_required', operationId }) })
  expect(operationStatus(cwd, id)).toMatchObject({ status: 'needs_authorization', authorizationOperationId: operationId })
  resumeDatabaseOperation(cwd, id)
  const execute = vi.fn(async () => ({ done: true }))
  await drainDurableOperations(cwd, execute)
  expect(execute).toHaveBeenCalledExactlyOnceWith(operation, options)
})
it.each(['backend-catalog', 'backend-policy', 'backend-integration-status', 'auth-config', 'auth-count'] as const)('marks a failed %s read definitive rather than uncertain', async operation => {
  const id = enqueueDatabaseOperation(cwd, operation, {})
  await drainDurableOperations(cwd, async () => { throw new Error('offline') })
  expect(readDurableOperation(cwd, id).status).toBe('failed')
})
it('fences concurrent workers so a slow operation runs exactly once', async () => {
  const id = enqueueDatabaseOperation(cwd, 'migrate', {})
  let release: (() => void) | undefined
  const execute = vi.fn(async () => new Promise<void>(resolve => { release = resolve }))
  const first = drainDurableOperations(cwd, execute)
  await drainDurableOperations(cwd, execute)
  expect(readDurableOperation(cwd, id).status).toBe('running')
  release!(); await first
  expect(execute).toHaveBeenCalledTimes(1)
})
it('reconciles a proved-dead owner as uncertain without stealing from a live or inaccessible PID', async () => {
  const id = enqueueDatabaseOperation(cwd, 'migrate', {})
  const file = path.join(cwd, '.supremo/database-queue/operations', `${id}.json`)
  const entry = readDurableOperation(cwd, id)
  fs.writeFileSync(file, JSON.stringify({ ...entry, status: 'running', owner: { pid: 987654, token: crypto.randomUUID() } }))
  const execute = vi.fn()
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('unknown'), { code: 'EPERM' }) })
  await drainDurableOperations(cwd, execute)
  expect(readDurableOperation(cwd, id).status).toBe('running')
  vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }) })
  await drainDurableOperations(cwd, execute)
  expect(readDurableOperation(cwd, id).status).toBe('uncertain')
  expect(execute).not.toHaveBeenCalled()
})
it('expires only unstarted requests independently of the interactive wait', async () => {
  const id = enqueueDatabaseOperation(cwd, 'status', {})
  const entry = readDurableOperation(cwd, id)
  fs.writeFileSync(path.join(cwd, '.supremo/database-queue/operations', `${id}.json`), JSON.stringify({ ...entry, expiresAt: Date.now() - 1 }))
  const execute = vi.fn()
  await drainDurableOperations(cwd, execute)
  expect(readDurableOperation(cwd, id).status).toBe('expired')
  expect(execute).not.toHaveBeenCalled()
})
it('does not write operation data through a symlinked directory', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-outside-'))
  try {
    fs.mkdirSync(path.join(cwd, '.supremo')); fs.symlinkSync(outside, path.join(cwd, '.supremo/database-queue'))
    expect(() => enqueueDatabaseOperation(cwd, 'status', {})).toThrow('Diretório')
    expect(fs.readdirSync(outside)).toEqual([])
  } finally { fs.rmSync(outside, { recursive: true, force: true }) }
})
it('refuses to deliver a queued operation after the checkout changes project identity', async () => {
  fs.mkdirSync(path.join(cwd, '.supremo'))
  const config = path.join(cwd, '.supremo/project.json')
  fs.writeFileSync(config, JSON.stringify({ projectId: '11111111-1111-4111-8111-111111111111', supremoUrl: 'https://supremo.example' }))
  const id = enqueueDatabaseOperation(cwd, 'migrate', {})
  fs.writeFileSync(config, JSON.stringify({ projectId: '22222222-2222-4222-8222-222222222222', supremoUrl: 'https://supremo.example' }))
  const execute = vi.fn()
  await drainDurableOperations(cwd, execute)
  expect(readDurableOperation(cwd, id)).toMatchObject({ status: 'failed' }); expect(execute).not.toHaveBeenCalled()
})
it('does not let one corrupt record starve other queued requests', async () => {
  const id = enqueueDatabaseOperation(cwd, 'status', {})
  fs.writeFileSync(path.join(cwd, '.supremo/database-queue/operations', `${crypto.randomUUID()}.json`), '{broken')
  const execute = vi.fn(async () => ({ ready: true }))
  await drainDurableOperations(cwd, execute)
  expect(readDurableOperation(cwd, id).status).toBe('succeeded'); expect(execute).toHaveBeenCalledTimes(1)
})
it('preserves an unverifiable lease without starving another operation or replaying effects', async () => {
  const blocked = enqueueDatabaseOperation(cwd, 'migrate', {}), next = enqueueDatabaseOperation(cwd, 'status', {})
  fs.writeFileSync(path.join(cwd, '.supremo/database-queue/operations', `${blocked}.lease`), '{broken')
  const execute = vi.fn(async () => ({ ready: true }))
  await drainDurableOperations(cwd, execute)
  expect(readDurableOperation(cwd, blocked).status).toBe('uncertain')
  expect(readDurableOperation(cwd, next).status).toBe('succeeded')
  expect(execute).toHaveBeenCalledExactlyOnceWith('status')
})
it('rejects changed input contracts before execution and continues the queue', async () => {
  const invalid = enqueueDatabaseOperation(cwd, 'status', {}), next = enqueueDatabaseOperation(cwd, 'status', {})
  fs.writeFileSync(path.join(cwd, '.supremo/database-queue/operations', `${invalid}.json`), JSON.stringify({ ...readDurableOperation(cwd, invalid), options: { arbitrary: true } }))
  const execute = vi.fn(async () => ({ ready: true }))
  await drainDurableOperations(cwd, execute)
  expect(readDurableOperation(cwd, invalid).status).toBe('failed')
  expect(readDurableOperation(cwd, next).status).toBe('succeeded')
  expect(execute).toHaveBeenCalledTimes(1)
})
it('returns within five seconds while a new worker retains ownership and delivers the eventual result', async () => {
  vi.useFakeTimers()
  let release: (() => void) | undefined
  const stop = startDatabaseWorker(cwd, async () => { await new Promise<void>(resolve => { release = resolve }); return { done: true } })
  try {
    const pending = requestDatabase(cwd, 'status')
    await vi.advanceTimersByTimeAsync(5000)
    const result = await pending as { operationId: string; status: string }
    expect(result.status).toBe('running')
    release!(); await vi.advanceTimersByTimeAsync(1)
    expect(operationStatus(cwd, result.operationId)).toMatchObject({ status: 'succeeded', result: { done: true } })
  } finally { stop() }
})
