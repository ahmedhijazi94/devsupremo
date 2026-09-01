import crypto from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { appAuthConfigured, buildAppJwt } from './git-clone-token'

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const decodeSegment = (seg: string) =>
  JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'))

describe('buildAppJwt', () => {
  it('gera um JWT RS256 com iss=appId e exp futuro', () => {
    const now = 1_700_000_000_000
    const jwt = buildAppJwt('12345', privateKey, now)
    const [h, p] = jwt.split('.')
    expect(decodeSegment(h!)).toMatchObject({ alg: 'RS256', typ: 'JWT' })
    const payload = decodeSegment(p!)
    expect(payload.iss).toBe('12345')
    expect(payload.exp).toBeGreaterThan(payload.iat)
  })

  it('a assinatura confere com a chave pública', () => {
    const jwt = buildAppJwt('12345', privateKey)
    const [h, p, sig] = jwt.split('.')
    const ok = crypto
      .createVerify('RSA-SHA256')
      .update(`${h}.${p}`)
      .verify(publicKey, Buffer.from(sig!, 'base64url'))
    expect(ok).toBe(true)
  })

  it('aceita chave com \\n literais (formato Vercel)', () => {
    const escaped = privateKey.replace(/\n/g, '\\n')
    expect(() => buildAppJwt('12345', escaped)).not.toThrow()
  })
})

describe('appAuthConfigured', () => {
  const saved = {
    id: process.env.GITHUB_APP_ID,
    key: process.env.GITHUB_APP_PRIVATE_KEY,
  }
  afterEach(() => {
    if (saved.id === undefined) delete process.env.GITHUB_APP_ID
    else process.env.GITHUB_APP_ID = saved.id
    if (saved.key === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY
    else process.env.GITHUB_APP_PRIVATE_KEY = saved.key
  })

  it('false sem a chave do App (usa fallback)', () => {
    delete process.env.GITHUB_APP_ID
    delete process.env.GITHUB_APP_PRIVATE_KEY
    expect(appAuthConfigured()).toBe(false)
  })

  it('true com App ID + private key', () => {
    process.env.GITHUB_APP_ID = '12345'
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey
    expect(appAuthConfigured()).toBe(true)
  })
})
