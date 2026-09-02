import { describe, expect, it } from 'vitest'
import {
  interpretSetupCallback,
  matchInstallation,
  type AppInstallation,
} from './app'

const installs: AppInstallation[] = [
  { id: 111, accountLogin: 'ahmedhijazi94', accountType: 'User' },
  { id: 222, accountLogin: 'Hijaziia', accountType: 'Organization' },
]

describe('matchInstallation — descoberta por conta/org', () => {
  it('acha a installation da organização Hijaziia', () => {
    const found = matchInstallation(installs, 'Hijaziia')
    expect(found?.id).toBe(222)
    expect(found?.accountType).toBe('Organization')
  })

  it('é case-insensitive (Hijaziia = hijaziia)', () => {
    expect(matchInstallation(installs, 'hijaziia')?.id).toBe(222)
  })

  it('acha a conta pessoal', () => {
    expect(matchInstallation(installs, 'ahmedhijazi94')?.id).toBe(111)
  })

  it('null quando a App não está instalada naquela conta', () => {
    expect(matchInstallation(installs, 'outra-org')).toBeNull()
  })
})

describe('interpretSetupCallback — Setup URL sem 404', () => {
  it('install com installation_id → sucesso em /accounts', () => {
    const r = interpretSetupCallback({
      installationId: '222',
      setupAction: 'install',
      hasUser: true,
    })
    expect(r.redirect).toBe('/accounts?success=github_app_installed')
  })

  it('update também é sucesso', () => {
    expect(
      interpretSetupCallback({ installationId: '222', setupAction: 'update', hasUser: true })
        .redirect,
    ).toBe('/accounts?success=github_app_installed')
  })

  it('sem sessão → /login', () => {
    expect(
      interpretSetupCallback({ installationId: '222', setupAction: 'install', hasUser: false })
        .redirect,
    ).toBe('/login')
  })

  it('sem installation_id → erro tratado (não 404)', () => {
    expect(
      interpretSetupCallback({ installationId: null, setupAction: 'install', hasUser: true })
        .redirect,
    ).toContain('error=github_app_no_installation')
  })

  it('setup_action=request (aprovação pendente de admin) → info', () => {
    expect(
      interpretSetupCallback({ installationId: '222', setupAction: 'request', hasUser: true })
        .redirect,
    ).toContain('info=github_app_pending_approval')
  })
})
