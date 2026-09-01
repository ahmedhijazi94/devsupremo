import { describe, expect, it } from 'vitest'
import {
  approveDeviceGrant,
  generateDeviceCode,
  generateUserCode,
  hashDeviceCode,
  isDeviceCode,
  lookupGrant,
  normalizeUserCode,
  pollDeviceGrant,
  startDeviceGrant,
  type DeviceGrantRow,
  type DeviceGrantStore,
  type GrantSummary,
  type PollResult,
} from './codes'

/** Store em memória com a MESMA semântica atômica exigida do store real. */
class MemStore implements DeviceGrantStore {
  rows: Array<
    DeviceGrantRow & {
      status: 'pending' | 'approved' | 'consumed' | 'denied'
      userId: string | null
      consumedAt: string | null
    }
  > = []

  async create(row: DeviceGrantRow): Promise<void> {
    this.rows.push({ ...row, status: 'pending', userId: null, consumedAt: null })
  }

  async findByUserCode(
    userCode: string,
    nowIso: string,
  ): Promise<GrantSummary | null> {
    const r = this.rows.find((x) => x.userCode === userCode)
    if (!r) return null
    return { projectId: r.projectId, status: r.status, expired: r.expiresAt <= nowIso }
  }

  async approve(
    userCode: string,
    userId: string,
    nowIso: string,
  ): Promise<{ projectId: string } | null> {
    const r = this.rows.find(
      (x) => x.userCode === userCode && x.status === 'pending' && x.expiresAt > nowIso,
    )
    if (!r) return null
    r.status = 'approved'
    r.userId = userId
    return { projectId: r.projectId }
  }

  async poll(deviceCodeHash: string, nowIso: string): Promise<PollResult> {
    const r = this.rows.find((x) => x.deviceCodeHash === deviceCodeHash)
    if (!r) return { status: 'gone' }
    if (r.status === 'approved' && r.expiresAt > nowIso) {
      r.status = 'consumed'
      r.consumedAt = nowIso
      return { status: 'ready', scope: { userId: r.userId!, projectId: r.projectId } }
    }
    if (r.expiresAt <= nowIso) return { status: 'expired' }
    if (r.status === 'pending') return { status: 'pending' }
    if (r.status === 'denied') return { status: 'denied' }
    return { status: 'gone' }
  }
}

describe('códigos', () => {
  it('device code é opaco, prefixado e aleatório', () => {
    const a = generateDeviceCode()
    expect(isDeviceCode(a)).toBe(true)
    expect(a).not.toBe(generateDeviceCode())
  })

  it('user code é curto, formatado e sem caracteres ambíguos', () => {
    const c = generateUserCode()
    expect(c).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)
  })

  it('normalizeUserCode aceita minúsculas/espaços e reinsere o hífen', () => {
    expect(normalizeUserCode('abcd efgh')).toBe('ABCD-EFGH')
    expect(normalizeUserCode('ABCDEFGH')).toBe('ABCD-EFGH')
  })
})

describe('device flow', () => {
  it('start cria pending guardando só o HASH do device code', async () => {
    const store = new MemStore()
    const { deviceCode, userCode } = await startDeviceGrant(store, 'proj-A')
    expect(store.rows).toHaveLength(1)
    const row = store.rows[0]!
    expect(row.deviceCodeHash).toBe(hashDeviceCode(deviceCode))
    expect(JSON.stringify(row)).not.toContain(deviceCode)
    expect(row.userCode).toBe(userCode)
    expect(row.status).toBe('pending')
  })

  it('poll antes de aprovar → pending', async () => {
    const store = new MemStore()
    const { deviceCode } = await startDeviceGrant(store, 'proj-A')
    expect(await pollDeviceGrant(store, deviceCode)).toEqual({ status: 'pending' })
  })

  it('aprovar → poll devolve o escopo UMA vez (one-time)', async () => {
    const store = new MemStore()
    const { deviceCode, userCode } = await startDeviceGrant(store, 'proj-A')
    expect(await approveDeviceGrant(store, userCode, 'user-A')).toEqual({
      projectId: 'proj-A',
    })
    expect(await pollDeviceGrant(store, deviceCode)).toEqual({
      status: 'ready',
      scope: { userId: 'user-A', projectId: 'proj-A' },
    })
    // segundo poll: já consumido
    expect(await pollDeviceGrant(store, deviceCode)).toEqual({ status: 'gone' })
  })

  it('aprovar com user_code desconhecido → null', async () => {
    const store = new MemStore()
    await startDeviceGrant(store, 'proj-A')
    expect(await approveDeviceGrant(store, 'ZZZZ-ZZZZ', 'user-A')).toBeNull()
  })

  it('expirado: aprovar falha e poll → expired', async () => {
    const store = new MemStore()
    const { deviceCode, userCode } = await startDeviceGrant(store, 'proj-A', {
      ttlMs: 1000,
      now: 0,
    })
    expect(await approveDeviceGrant(store, userCode, 'user-A', { now: 10_000 })).toBeNull()
    expect(await pollDeviceGrant(store, deviceCode, { now: 10_000 })).toEqual({
      status: 'expired',
    })
  })

  it('device code inválido nem chega ao store', async () => {
    const store = new MemStore()
    expect(await pollDeviceGrant(store, 'lixo')).toEqual({ status: 'gone' })
  })

  it('isolamento: o device code de A não devolve o grant de B', async () => {
    const store = new MemStore()
    const a = await startDeviceGrant(store, 'proj-A')
    const b = await startDeviceGrant(store, 'proj-B')
    await approveDeviceGrant(store, b.userCode, 'user-B')
    // poll de A ainda pending (só B foi aprovado)
    expect(await pollDeviceGrant(store, a.deviceCode)).toEqual({ status: 'pending' })
    // poll de B devolve o escopo de B
    expect(await pollDeviceGrant(store, b.deviceCode)).toEqual({
      status: 'ready',
      scope: { userId: 'user-B', projectId: 'proj-B' },
    })
  })

  it('lookupGrant resume o grant pro browser (achando por user_code)', async () => {
    const store = new MemStore()
    const { userCode } = await startDeviceGrant(store, 'proj-A')
    const summary = await lookupGrant(store, userCode.toLowerCase())
    expect(summary).toEqual({ projectId: 'proj-A', status: 'pending', expired: false })
  })
})
