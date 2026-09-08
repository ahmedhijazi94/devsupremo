import { describe, expect, it, vi } from 'vitest'
import { deviceIssuer, readDeviceSecret, saveDeviceIdentity } from './device-identity'
import type { Keychain } from './keychain'
import { fetchTurnContext } from './turn-context-client'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const ISSUER = 'https://supremo.example.invalid'
const SECRET = 'sup_dev_ckpt_' + 'x'.repeat(43)
function fixture(): { keychain: Keychain; values: Map<string, string> } {
  const values = new Map<string, string>()
  return { values, keychain: { get: id => values.get(id) ?? null, save: (id, value) => { values.set(id, value) }, remove: id => { values.delete(id) } } }
}

describe('device credentials are bound to their authenticated issuer outside the checkout', () => {
  it('persists and verifies project plus canonical issuer through the same keychain interface', () => {
    const { keychain, values } = fixture()
    saveDeviceIdentity(keychain, PROJECT, `${ISSUER}:443/`, SECRET)
    expect(readDeviceSecret(keychain, PROJECT, ISSUER)).toBe(SECRET)
    expect(JSON.parse(values.get(`identity-v1:${PROJECT}`)!)).toMatchObject({ version: 1, projectId: PROJECT, issuer: ISSUER })
  })
  it.each(['https://attacker.example.invalid', 'http://localhost', `${ISSUER}:8443`, `${ISSUER}/other`])('rejects changed destination %s without returning the credential', destination => {
    const { keychain } = fixture(); saveDeviceIdentity(keychain, PROJECT, ISSUER, SECRET)
    expect(() => readDeviceSecret(keychain, PROJECT, destination)).toThrow('Origem')
  })
  it('does not migrate a bare legacy secret from untrusted checkout configuration', () => {
    const { keychain, values } = fixture(); values.set(PROJECT, SECRET)
    expect(() => readDeviceSecret(keychain, PROJECT, ISSUER)).toThrow('sem origem verificável')
    expect(values.get(PROJECT)).toBe(SECRET)
    // The existing checkout can reauthorize; only a fresh device-flow credential is persisted.
    saveDeviceIdentity(keychain, PROJECT, ISSUER, 'newly-issued-device-secret')
    expect(readDeviceSecret(keychain, PROJECT, ISSUER)).toBe('newly-issued-device-secret')
    expect(keychain.get(PROJECT)).toBeNull() // an old daemon cannot retrieve the new credential
  })
  it('rejects a copied identity for a different project', () => {
    const { keychain, values } = fixture(); saveDeviceIdentity(keychain, PROJECT, ISSUER, SECRET)
    values.set(`identity-v1:${OTHER}`, values.get(`identity-v1:${PROJECT}`)!)
    expect(() => readDeviceSecret(keychain, OTHER, ISSUER)).toThrow('Origem')
  })
  it.each(['http://example.invalid', 'https://user:password@example.invalid', `${ISSUER}?token=x`, `${ISSUER}#other`])('validates %s before accessing private storage', issuer => {
    const { keychain } = fixture(), get = vi.spyOn(keychain, 'get')
    expect(() => readDeviceSecret(keychain, PROJECT, issuer)).toThrow()
    expect(get).not.toHaveBeenCalled()
  })
  it('protects reconciliation requests before the fetch boundary', async () => {
    const { keychain } = fixture(); saveDeviceIdentity(keychain, PROJECT, ISSUER, SECRET)
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    try {
      await expect(fetchTurnContext(PROJECT, 'https://attacker.example.invalid', id =>
        readDeviceSecret(keychain, id, 'https://attacker.example.invalid'))).rejects.toThrow('Origem')
      expect(fetch).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })
  it('keeps loopback ports and hosted installation base paths distinct', () => {
    expect(deviceIssuer('http://localhost:3000/install/')).toBe('http://localhost:3000/install')
    const { keychain } = fixture(); saveDeviceIdentity(keychain, PROJECT, 'http://localhost:3000/install', SECRET)
    expect(() => readDeviceSecret(keychain, PROJECT, 'http://localhost:3001/install')).toThrow()
    expect(() => readDeviceSecret(keychain, PROJECT, 'http://localhost:3000')).toThrow()
  })
})
