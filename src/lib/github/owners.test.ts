import { describe, expect, it } from 'vitest'
import {
  isOwnerAllowed,
  ownerTypeOf,
  repoCreationPlan,
  resolveSelectableOwners,
} from './owners'
import type { AppInstallation } from './app'

const appInstalls: AppInstallation[] = [
  { id: 1, accountLogin: 'ahmedhijazi94', accountType: 'User' },
  { id: 2, accountLogin: 'Hijaziia', accountType: 'Organization' },
  { id: 3, accountLogin: 'OutraOrgDoOutroUser', accountType: 'Organization' },
]

describe('resolveSelectableOwners — interseção segura', () => {
  it('conta pessoal sempre aparece (fluxo OAuth do próprio usuário)', () => {
    const owners = resolveSelectableOwners({
      userLogin: 'ahmedhijazi94',
      userOrgLogins: [],
      appInstallations: appInstalls,
    })
    expect(owners).toContainEqual({ login: 'ahmedhijazi94', type: 'personal' })
  })

  it('org aparece quando o usuário É membro E a App está instalada', () => {
    const owners = resolveSelectableOwners({
      userLogin: 'ahmedhijazi94',
      userOrgLogins: ['Hijaziia'],
      appInstallations: appInstalls,
    })
    expect(owners).toContainEqual({ login: 'Hijaziia', type: 'organization' })
  })

  it('installation SEM relação com o usuário NÃO aparece (isolamento A×B)', () => {
    // A App está instalada em OutraOrgDoOutroUser, mas o usuário não é membro.
    const owners = resolveSelectableOwners({
      userLogin: 'ahmedhijazi94',
      userOrgLogins: ['Hijaziia'], // usuário só é membro da Hijaziia
      appInstallations: appInstalls,
    })
    expect(owners.map((o) => o.login)).not.toContain('OutraOrgDoOutroUser')
  })

  it('org acessível mas SEM App instalada não aparece como pronta', () => {
    const owners = resolveSelectableOwners({
      userLogin: 'ahmedhijazi94',
      userOrgLogins: ['OrgSemApp'], // membro, mas App não instalada
      appInstallations: appInstalls,
    })
    expect(owners.map((o) => o.login)).not.toContain('OrgSemApp')
  })

  it('sem conta GitHub conectada → nenhum owner', () => {
    expect(
      resolveSelectableOwners({ userLogin: '', userOrgLogins: [], appInstallations: [] }),
    ).toEqual([])
  })
})

describe('isOwnerAllowed — autorização anti-forja no servidor', () => {
  const owners = resolveSelectableOwners({
    userLogin: 'ahmedhijazi94',
    userOrgLogins: ['Hijaziia'],
    appInstallations: appInstalls,
  })

  it('aceita owner do conjunto selecionável', () => {
    expect(isOwnerAllowed(owners, 'ahmedhijazi94')).toBe(true)
    expect(isOwnerAllowed(owners, 'Hijaziia')).toBe(true)
    expect(isOwnerAllowed(owners, 'hijaziia')).toBe(true) // case-insensitive
  })

  it('REJEITA owner forjado (org não autorizada ao usuário)', () => {
    expect(isOwnerAllowed(owners, 'OutraOrgDoOutroUser')).toBe(false)
    expect(isOwnerAllowed(owners, 'org-aleatoria')).toBe(false)
  })
})

describe('repoCreationPlan — caminho por tipo de owner', () => {
  it('organização → /orgs/{org}/repos com installation token', () => {
    expect(repoCreationPlan({ login: 'Hijaziia', type: 'organization' })).toEqual({
      endpoint: '/orgs/Hijaziia/repos',
      tokenSource: 'org_installation',
    })
  })

  it('pessoal → /user/repos com OAuth do usuário (fluxo preservado)', () => {
    expect(repoCreationPlan({ login: 'ahmedhijazi94', type: 'personal' })).toEqual({
      endpoint: '/user/repos',
      tokenSource: 'user_oauth',
    })
  })

  it('ownerTypeOf resolve o tipo do owner selecionado', () => {
    const owners = resolveSelectableOwners({
      userLogin: 'ahmedhijazi94',
      userOrgLogins: ['Hijaziia'],
      appInstallations: appInstalls,
    })
    expect(ownerTypeOf(owners, 'Hijaziia')).toBe('organization')
    expect(ownerTypeOf(owners, 'ahmedhijazi94')).toBe('personal')
    expect(ownerTypeOf(owners, 'nao-existe')).toBeNull()
  })
})
