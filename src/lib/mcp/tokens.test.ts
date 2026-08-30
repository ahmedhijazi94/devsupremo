import { describe, expect, it } from 'vitest'
import {
  generateMcpToken,
  hashMcpToken,
  parseAuthorizationHeader,
} from './tokens'

describe('generateMcpToken', () => {
  it('gera token com o prefixo sup_', () => {
    expect(generateMcpToken().token).toMatch(/^sup_/)
  })

  it('nunca repete', () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => generateMcpToken().token)
    )
    expect(tokens.size).toBe(200)
  })

  it('o hash guardado corresponde ao token em claro', () => {
    const { token, tokenHash } = generateMcpToken()
    expect(hashMcpToken(token)).toBe(tokenHash)
  })

  it('o hash não contém o token', () => {
    const { token, tokenHash } = generateMcpToken()
    expect(tokenHash).not.toContain(token.slice(4))
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('o prefixo exibido é curto e não reconstrói o token', () => {
    const { token, tokenPrefix } = generateMcpToken()
    expect(tokenPrefix).toHaveLength(10)
    expect(token.startsWith(tokenPrefix)).toBe(true)
    expect(tokenPrefix.length).toBeLessThan(token.length / 3)
  })
})

describe('hashMcpToken', () => {
  it('é determinístico', () => {
    expect(hashMcpToken('sup_abc')).toBe(hashMcpToken('sup_abc'))
  })

  it('muda completamente com um caractere a mais', () => {
    expect(hashMcpToken('sup_abc')).not.toBe(hashMcpToken('sup_abd'))
  })
})

describe('parseAuthorizationHeader', () => {
  it('aceita Bearer', () => {
    expect(parseAuthorizationHeader('Bearer sup_abc123')).toBe('sup_abc123')
  })

  it('aceita bearer minúsculo', () => {
    expect(parseAuthorizationHeader('bearer sup_abc123')).toBe('sup_abc123')
  })

  it('aceita o token cru', () => {
    expect(parseAuthorizationHeader('sup_abc123')).toBe('sup_abc123')
  })

  it('tolera espaço extra', () => {
    expect(parseAuthorizationHeader('  Bearer   sup_abc123  ')).toBe(
      'sup_abc123'
    )
  })

  it('recusa header ausente', () => {
    expect(parseAuthorizationHeader(null)).toBeNull()
  })

  it('recusa token sem o prefixo do Supremo', () => {
    expect(parseAuthorizationHeader('Bearer ghp_umTokenDoGithub')).toBeNull()
    expect(parseAuthorizationHeader('Basic dXNlcjpwYXNz')).toBeNull()
  })

  it('recusa string vazia', () => {
    expect(parseAuthorizationHeader('')).toBeNull()
    expect(parseAuthorizationHeader('Bearer ')).toBeNull()
  })
})
