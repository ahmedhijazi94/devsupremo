import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Invariantes de HARDENING do endpoint de publish (v3.1 item 4 endurecido).
 * São checagens estruturais do código da rota — a garantia de que NENHUMA
 * credencial GitHub com write escapa do backend não pode depender de E2E.
 */

const apiDir = join(__dirname, '../../app/api/checkpoint')
const publishRoute = readFileSync(join(apiDir, 'publish/route.ts'), 'utf8')

describe('endpoint de publish — nenhum token sai do backend (testes 1, 2, 15, 16)', () => {
  it('as rotas que ENTREGAVAM token foram removidas', () => {
    // push-grant devolvia { token } ao daemon; ensure-pr também usava fluxo antigo.
    expect(existsSync(join(apiDir, 'push-grant/route.ts'))).toBe(false)
    expect(existsSync(join(apiDir, 'ensure-pr/route.ts'))).toBe(false)
  })

  it('só existe a rota publish', () => {
    expect(existsSync(join(apiDir, 'publish/route.ts'))).toBe(true)
  })

  it('a resposta NUNCA inclui token (Response.json sem variáveis de token)', () => {
    // Toda resposta de sucesso/erro só devolve prNumber/url/published/idempotent/error.
    const responses = publishRoute.match(/Response\.json\(([\s\S]*?)\)/g) ?? []
    expect(responses.length).toBeGreaterThan(0)
    for (const r of responses) {
      expect(r).not.toMatch(/token/i)
      expect(r).not.toMatch(/scoped/)
      expect(r).not.toMatch(/secret/i)
    }
  })

  it('o token é emitido, usado e REVOGADO server-side (nunca logado)', () => {
    expect(publishRoute).toContain('mintRepoScopedToken')
    expect(publishRoute).toContain('revokeInstallationToken')
    // nada de console.* despejando token/secret
    expect(publishRoute).not.toMatch(/console\.[a-z]+\([^)]*token/i)
    expect(publishRoute).not.toMatch(/console\.[a-z]+\([^)]*secret/i)
  })

  it('deriva repo/owner do project_id (nunca aceita owner/repo do cliente)', () => {
    // o repo vem da decisão de autorização sobre o projeto carregado, não do body
    expect(publishRoute).toContain('decision.repoFullName')
    expect(publishRoute).not.toMatch(/body\.(repo|owner|repoFullName)/)
  })

  it('deriva a branch server-side e nunca aceita ref/branch do cliente', () => {
    expect(publishRoute).toContain('planIntegration')
    expect(publishRoute).toContain('plan.branch')
    // não lê branch/ref do corpo da requisição
    expect(publishRoute).not.toMatch(/body\.(branch|ref)/)
  })

  it('não faz merge (CI/merge continuam no Control Plane; teste 13)', () => {
    expect(publishRoute).not.toContain('mergePullRequest')
    expect(publishRoute).not.toContain('enableNativeAutoMerge')
  })
})
