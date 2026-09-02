import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Invariantes estruturais das rotas de restore (v3.1 finalização) — o pedido de
 * restore nunca fala com o GitHub nem usa credencial de write; ele só coordena
 * LOCAL ↔ Supremo. Quem aplica o código é o daemon (via patch local); quem
 * publica o checkpoint resultante é a rota /publish de sempre (mesmos gates).
 */

const apiDir = join(__dirname, '../../app/api/checkpoint')
const pollRoute = readFileSync(join(apiDir, 'restore-poll/route.ts'), 'utf8')
const reportRoute = readFileSync(join(apiDir, 'restore-report/route.ts'), 'utf8')

describe('restore-poll — reivindica sem tocar no GitHub', () => {
  it('autentica o device (fail-closed) antes de qualquer coisa', () => {
    expect(pollRoute).toContain('authenticateDeviceSecret')
  })
  it('autoriza o alvo contra o PROJETO pedido (nunca cross-project)', () => {
    expect(pollRoute).toContain('authorizeRestoreRequest')
  })
  it('claim é atômico (evita dois devices aplicando o mesmo restore)', () => {
    expect(pollRoute).toContain('claimPendingRestoreRequests')
  })
  it('NÃO fala com a API do GitHub nem menciona token/installation', () => {
    // .toContain (substring literal), não regex: é isso que checamos — "essa
    // string aparece em algum lugar do arquivo" — e evita o falso positivo do
    // CodeQL js/regex/missing-regexp-anchor (a checagem não é validação de URL
    // não-âncorada, é presença literal de texto no código-fonte do arquivo).
    expect(pollRoute).not.toContain('api.github.com')
    expect(pollRoute).not.toMatch(/mintRepoScopedToken|installationCreds|appTokenForRepo/)
  })
})

describe('restore-report — só fecha o pedido, não publica nada', () => {
  it('autentica o device (fail-closed) antes de qualquer coisa', () => {
    expect(reportRoute).toContain('authenticateDeviceSecret')
  })
  it('autoriza o restoreRequestId contra o DONO do device (IDOR — ver route.test.ts)', () => {
    expect(reportRoute).toContain('authorizeRestoreReport')
    expect(reportRoute).toContain('getRestoreRequestProjectOwner')
  })
  it('só dois desfechos possíveis: applied | failed (discriminated union)', () => {
    expect(reportRoute).toContain("z.literal('applied')")
    expect(reportRoute).toContain("z.literal('failed')")
  })
  it('NÃO fala com a API do GitHub nem menciona token/installation', () => {
    expect(reportRoute).not.toContain('api.github.com')
    expect(reportRoute).not.toMatch(/mintRepoScopedToken|installationCreds|appTokenForRepo/)
  })
})
