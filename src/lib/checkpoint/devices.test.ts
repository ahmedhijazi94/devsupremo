import { describe, expect, it } from 'vitest'
import {
  authenticateDevice,
  authenticateDeviceSecret,
  generateDeviceSecret,
  hashDeviceSecret,
  isDeviceSecret,
  registerDevice,
  type CheckpointDeviceRow,
  type CheckpointDeviceStore,
} from './devices'

const row = (over: Partial<CheckpointDeviceRow> = {}): CheckpointDeviceRow => ({
  id: 'dev-1',
  ownerUserId: 'user-1',
  label: 'macbook',
  revokedAt: null,
  ...over,
})

describe('device secret (puro)', () => {
  it('gera com prefixo e hash determinístico', () => {
    const s = generateDeviceSecret()
    expect(isDeviceSecret(s)).toBe(true)
    expect(hashDeviceSecret(s)).toBe(hashDeviceSecret(s))
    expect(hashDeviceSecret(s)).not.toBe(hashDeviceSecret(generateDeviceSecret()))
  })
})

describe('authenticateDevice — device não autorizado não passa (teste 4)', () => {
  it('secret malformado → recusa', () => {
    expect(authenticateDevice('lixo', row())).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })
  it('device inexistente → recusa', () => {
    expect(authenticateDevice(generateDeviceSecret(), null)).toEqual({
      ok: false,
      reason: 'unknown_device',
    })
  })
  it('device REVOGADO → recusa (fail-closed)', () => {
    const r = authenticateDevice(generateDeviceSecret(), row({ revokedAt: '2026-01-01' }))
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ reason: 'revoked' })
  })
  it('device válido e ativo → autentica', () => {
    const r = authenticateDevice(generateDeviceSecret(), row())
    expect(r.ok).toBe(true)
  })
})

describe('registerDevice / authenticateDeviceSecret (store falso)', () => {
  it('registra guardando só o hash e autentica pelo secret', async () => {
    const saved: { secretHash?: string } = {}
    const store: CheckpointDeviceStore = {
      async create(input) {
        saved.secretHash = input.secretHash
        return { id: 'dev-9' }
      },
      async findBySecretHash(hash) {
        return hash === saved.secretHash ? row({ id: 'dev-9' }) : null
      },
      async touch() {},
      async revoke() {},
    }
    const { deviceId, deviceSecret } = await registerDevice(store, {
      ownerUserId: 'user-1',
      label: 'ci',
    })
    expect(deviceId).toBe('dev-9')
    // o que foi guardado é o HASH, nunca o secret
    expect(saved.secretHash).toBe(hashDeviceSecret(deviceSecret))
    expect(saved.secretHash).not.toContain(deviceSecret)

    const ok = await authenticateDeviceSecret(store, deviceSecret)
    expect(ok.ok).toBe(true)
    const bad = await authenticateDeviceSecret(store, generateDeviceSecret())
    expect(bad.ok).toBe(false)
  })
})
