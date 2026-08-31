import { describe, it, expect } from 'vitest'
import { signRealtimeToken, verifyRealtimeToken } from './realtime-token'

const SECRET = 'test-jwt-secret-0123456789'
const USER = '11111111-1111-4111-8111-111111111111'

describe('signRealtimeToken', () => {
  it('emite um JWT válido escopado ao usuário', () => {
    const { token, claims } = signRealtimeToken(USER, SECRET, 3600)
    expect(token.split('.')).toHaveLength(3)
    expect(claims.sub).toBe(USER)
    expect(claims.role).toBe('authenticated')
    expect(claims.exp).toBeGreaterThan(claims.iat)
    expect(verifyRealtimeToken(token, SECRET)).toBe(true)
  })

  it('assinatura não confere com outro segredo', () => {
    const { token } = signRealtimeToken(USER, SECRET)
    expect(verifyRealtimeToken(token, 'outro-segredo')).toBe(false)
  })

  it('exige o segredo', () => {
    expect(() => signRealtimeToken(USER, '')).toThrow()
  })
})
