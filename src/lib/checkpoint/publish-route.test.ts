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

/**
 * Proteção CROSS-MACHINE (v3.3, item 5) — duas máquinas publicando a partir
 * do MESMO checkpoint conhecido: a checagem tem que rodar cedo (nunca emite
 * token nem chama o GitHub pra um checkpoint que vai ser recusado por base
 * desatualizada) e nunca sobrescrever silenciosamente o que já foi publicado
 * (recusa — nunca aplica por cima).
 */
describe('endpoint de publish — base desatualizada (cross-machine) é recusada ANTES do GitHub (v3.3)', () => {
  it('usa a mesma decisão pura já testada isoladamente (baseCheckpointIsFresh)', () => {
    expect(publishRoute).toContain('baseCheckpointIsFresh')
    expect(publishRoute).toContain('getLatestKnownCheckpoint')
  })

  it('a checagem roda ANTES de qualquer chamada ao GitHub/token (appTokenForRepo/mintRepoScopedToken)', () => {
    const baseCheckIdx = publishRoute.indexOf('baseCheckpointIsFresh(')
    const controlTokenIdx = publishRoute.indexOf('appTokenForRepo(')
    const writeTokenIdx = publishRoute.indexOf('mintRepoScopedToken(')
    expect(baseCheckIdx).toBeGreaterThan(-1)
    expect(controlTokenIdx).toBeGreaterThan(-1)
    expect(writeTokenIdx).toBeGreaterThan(-1)
    expect(baseCheckIdx).toBeLessThan(controlTokenIdx)
    expect(baseCheckIdx).toBeLessThan(writeTokenIdx)
  })

  it('recusa marca push_status "failed" (nunca aplica o changeset por cima — ver applyChangeset abaixo da checagem)', () => {
    const baseCheckIdx = publishRoute.indexOf('baseCheckpointIsFresh(')
    const applyIdx = publishRoute.indexOf('applyChangeset(')
    expect(publishRoute).toContain("'stale_base'")
    expect(publishRoute).toMatch(/setCheckpointPushStatus\(client, changeset\.checkpointId, 'failed'/)
    expect(baseCheckIdx).toBeLessThan(applyIdx)
  })

  it('a base declarada vem do PRÓPRIO changeset (parent_checkpoint_id já existente) — nunca um campo novo do cliente', () => {
    expect(publishRoute).toContain('changeset.parentCheckpointId')
    expect(publishRoute).not.toMatch(/body\.(baseSha|baseCheckpointId)\b/)
  })

  it('resposta de recusa nunca inclui token/segredo (mesmo invariante do resto do endpoint)', () => {
    const idx = publishRoute.indexOf("reason: 'stale_base'")
    expect(idx).toBeGreaterThan(-1)
    const around = publishRoute.slice(Math.max(0, idx - 300), idx + 100)
    expect(around).not.toMatch(/token/i)
    expect(around).not.toMatch(/secret/i)
  })
})
