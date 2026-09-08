import { z } from 'zod'
import type { Keychain } from './keychain'

const identitySchema = z.object({ version: z.literal(1), projectId: z.string().uuid(),
  issuer: z.string(), secret: z.string().min(1).max(4096) }).strict()
// Old CLI builds read the project-only slot and cannot enforce issuer binding.
// Keep new identities in a separate namespace, then retire that legacy slot.
const identityAccount = (projectId: string): string => `identity-v1:${projectId}`

/** Canonical authority, including a self-hosted installation's base path. */
export function deviceIssuer(raw: string): string {
  const url = new URL(raw)
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Origem do Supremo inválida; use HTTPS ou loopback sem credenciais, query ou fragmento.')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/** Called only after the browser device flow returns a credential from this issuer. */
export function saveDeviceIdentity(keychain: Keychain, projectId: string, issuer: string, secret: string): void {
  const identity = identitySchema.parse({ version: 1, projectId, issuer: deviceIssuer(issuer), secret })
  keychain.save(identityAccount(projectId), JSON.stringify(identity))
  if (readDeviceSecret(keychain, projectId, issuer) !== secret) throw new Error('Identidade não confirmada no keychain após salvar.')
  keychain.remove(projectId)
}

/** A writable checkout never supplies proof of the issuer of an existing secret. */
export function readDeviceSecret(keychain: Keychain, projectId: string, issuer: string): string | null {
  z.string().uuid().parse(projectId)
  const expected = deviceIssuer(issuer)
  const stored = keychain.get(identityAccount(projectId))
  if (!stored) {
    if (keychain.get(projectId)) throw new Error('Autorização antiga sem origem verificável. Reautorize este projeto com supremo authorize --url <origem confiável>. Nenhuma credencial foi enviada.')
    return null
  }
  let value: unknown
  try { value = JSON.parse(stored) as unknown }
  catch { throw new Error('Autorização antiga sem origem verificável. Reautorize este projeto com supremo authorize --url <origem confiável>. Nenhuma credencial foi enviada.') }
  const identity = identitySchema.safeParse(value)
  if (!identity.success || identity.data.projectId !== projectId || identity.data.issuer !== expected) {
    throw new Error('Origem do backend diverge da identidade autorizada no keychain. Nenhuma credencial foi enviada; confira a URL ou reautorize na origem confiável.')
  }
  return identity.data.secret
}
