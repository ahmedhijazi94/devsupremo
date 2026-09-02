import { describe, expect, it } from 'vitest'
import {
  accountNeedsReconnect,
  GITHUB_OAUTH_SCOPES,
  GITHUB_OAUTH_SCOPE_STRING,
  ORG_SCOPE,
} from './scopes'

describe('scopes OAuth do GitHub', () => {
  it('inclui read:org (necessário para listar organizações)', () => {
    expect(GITHUB_OAUTH_SCOPES).toContain('read:org')
    expect(ORG_SCOPE).toBe('read:org')
    expect(GITHUB_OAUTH_SCOPE_STRING).toContain('read:org')
  })

  it('preserva os scopes já necessários (repo/delete_repo/workflow/identidade)', () => {
    for (const s of ['repo', 'read:user', 'user:email', 'delete_repo', 'workflow']) {
      expect(GITHUB_OAUTH_SCOPES).toContain(s)
    }
  })
})

describe('accountNeedsReconnect — não fingir conexão completa', () => {
  it('conta ANTIGA sem read:org (token sem acesso a org) → precisa reconectar', () => {
    // exatamente o estado real observado: read:org ausente
    const old = ['delete_repo', 'read:user', 'repo', 'user:email', 'workflow']
    expect(accountNeedsReconnect(old)).toBe(true)
  })

  it('conta com TODOS os scopes (inclui read:org) → não precisa reconectar', () => {
    expect(accountNeedsReconnect([...GITHUB_OAUTH_SCOPES])).toBe(false)
  })

  it('admin:org satisfaz read:org', () => {
    const withAdmin = ['repo', 'read:user', 'user:email', 'delete_repo', 'workflow', 'admin:org']
    expect(accountNeedsReconnect(withAdmin)).toBe(false)
  })

  it('scopes ausentes/nulos → precisa reconectar (fail-safe)', () => {
    expect(accountNeedsReconnect(null)).toBe(true)
    expect(accountNeedsReconnect([])).toBe(true)
  })
})
