import { describe, expect, it, afterEach } from 'vitest'
import crypto from 'crypto'
import { encryptToken, decryptToken } from './crypto'

const VALID_KEY = process.env.ENCRYPTION_KEY

afterEach(() => {
  process.env.ENCRYPTION_KEY = VALID_KEY
})

describe('encryptToken / decryptToken', () => {
  it('faz round-trip de um token', () => {
    const secret = 'gho_umTokenDoGithubQualquer123456789'
    expect(decryptToken(encryptToken(secret))).toBe(secret)
  })

  it('preserva unicode', () => {
    const secret = 'senha-com-acentuação-e-emoji-🔐'
    expect(decryptToken(encryptToken(secret))).toBe(secret)
  })

  it('usa IV novo a cada chamada — cifras iguais nunca se repetem', () => {
    const secret = 'mesmo-valor'
    expect(encryptToken(secret)).not.toBe(encryptToken(secret))
  })

  it('produz o formato iv:authTag:dados', () => {
    const parts = encryptToken('x').split(':')
    expect(parts).toHaveLength(3)
    expect(parts[0]).toMatch(/^[0-9a-f]{32}$/)
    expect(parts[1]).toMatch(/^[0-9a-f]{32}$/)
  })

  it('passa string vazia adiante sem cifrar', () => {
    expect(encryptToken('')).toBe('')
    expect(decryptToken('')).toBe('')
  })
})

describe('decryptToken — integridade', () => {
  it('recusa quando os dados foram adulterados', () => {
    const encrypted = encryptToken('token-original')
    const [iv, tag, data] = encrypted.split(':')
    const tampered = `${iv}:${tag}:${flipLastHexDigit(data!)}`

    expect(() => decryptToken(tampered)).toThrow()
  })

  it('recusa quando o authTag foi adulterado', () => {
    const encrypted = encryptToken('token-original')
    const [iv, tag, data] = encrypted.split(':')
    const tampered = `${iv}:${flipLastHexDigit(tag!)}:${data}`

    expect(() => decryptToken(tampered)).toThrow()
  })

  it('recusa quando o IV foi trocado', () => {
    const encrypted = encryptToken('token-original')
    const [, tag, data] = encrypted.split(':')
    const otherIv = crypto.randomBytes(16).toString('hex')

    expect(() => decryptToken(`${otherIv}:${tag}:${data}`)).toThrow()
  })

  it('recusa formato inválido', () => {
    expect(() => decryptToken('sem-os-dois-pontos')).toThrow(
      /Invalid encrypted text format/
    )
    expect(() => decryptToken('so:duas')).toThrow()
  })

  it('não decifra com outra chave', () => {
    const encrypted = encryptToken('segredo')
    process.env.ENCRYPTION_KEY = 'a'.repeat(64)

    expect(() => decryptToken(encrypted)).toThrow()
  })
})

describe('validação da chave', () => {
  it('recusa chave ausente', () => {
    delete process.env.ENCRYPTION_KEY
    expect(() => encryptToken('x')).toThrow(/64-character hex/)
  })

  it('recusa chave com tamanho errado', () => {
    process.env.ENCRYPTION_KEY = 'abc123'
    expect(() => encryptToken('x')).toThrow(/64-character hex/)
  })
})

function flipLastHexDigit(hex: string): string {
  const last = hex.slice(-1)
  const flipped = last === '0' ? '1' : '0'
  return hex.slice(0, -1) + flipped
}
