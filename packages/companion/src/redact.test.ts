import { describe, it, expect } from 'vitest'
import { redact, redactWith } from './redact'

describe('redact — secrets nunca vazam no log', () => {
  it('mascara token do Supremo', () => {
    expect(redact('token=sup_abc123DEF456ghi789')).not.toContain('sup_abc123')
  })
  it('mascara token do GitHub', () => {
    expect(redact('ghp_0123456789abcdefghij0123456789abcdef')).toContain('gh_***')
  })
  it('mascara JWT', () => {
    const jwt = 'eyJhbGciOiJI.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4'
    expect(redact(jwt)).toContain('jwt_***')
  })
  it('mascara Authorization Bearer', () => {
    expect(redact('Authorization: Bearer supersecretvalue')).not.toContain(
      'supersecretvalue',
    )
  })
  it('redactWith pega segredo sem formato conhecido', () => {
    const secret = 'X9k2mQ7wLp4'
    expect(redactWith(`valor=${secret}`, [secret])).not.toContain(secret)
  })
  it('é idempotente', () => {
    const once = redact('sup_abcdefghij123')
    expect(redact(once)).toBe(once)
  })
})
