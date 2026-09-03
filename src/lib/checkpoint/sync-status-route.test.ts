import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Invariantes estruturais de `/api/checkpoint/sync-status` (v3.3 —
 * sincronização entre máquinas). É uma checagem LEVE: um SELECT no banco
 * (via `getLatestKnownCheckpoint`, a MESMA query que o publish usa pra
 * proteção cross-machine — nunca um segundo sistema de versão), nunca fala
 * com o GitHub. Mesmo padrão de auth de `/restore-poll`.
 */

const route = readFileSync(
  join(__dirname, '../../app/api/checkpoint/sync-status/route.ts'),
  'utf8',
)

describe('sync-status — checagem leve, sem GitHub, dono do projeto (v3.3)', () => {
  it('autentica o device (fail-closed) antes de qualquer coisa', () => {
    expect(route).toContain('authenticateDeviceSecret')
  })

  it('exige que o device seja do DONO do projeto (mesma checagem de restore-poll/publish)', () => {
    expect(route).toContain('auth.device.ownerUserId')
  })

  it('reaproveita a MESMA query do publish (getLatestKnownCheckpoint) — nunca um sistema de versão paralelo', () => {
    expect(route).toContain('getLatestKnownCheckpoint')
  })

  /**
   * Ajuste (item 2): a resposta precisa carregar o SHA exato do checkpoint
   * (`published_sha`, já gravado no publish) — sem ele o client não tem como
   * pinar o fast-forward e ficaria vulnerável à race de `integration_branch`
   * (a branch pode ganhar um checkpoint novo de outra máquina entre a
   * consulta e o fetch; ver packages/cli/src/sync.ts).
   */
  it('resposta inclui publishedSha (pra sync.ts pinar o fast-forward, nunca seguir o tip móvel da branch)', () => {
    expect(route).toMatch(/publishedSha:\s*latest\.publishedSha/)
  })

  it('NÃO fala com a API do GitHub nem menciona token/installation — é só um SELECT', () => {
    expect(route).not.toContain('api.github.com')
    expect(route).not.toMatch(/mintRepoScopedToken|installationCreds|appTokenForRepo/)
  })

  it('nunca aceita/deriva branch, repo ou owner do cliente', () => {
    expect(route).not.toMatch(/body\.(repo|owner|branch|ref)\b/)
  })

  it('resposta nunca inclui token/segredo', () => {
    const responses = route.match(/Response\.json\(([\s\S]*?)\)/g) ?? []
    expect(responses.length).toBeGreaterThan(0)
    for (const r of responses) {
      expect(r).not.toMatch(/token/i)
      expect(r).not.toMatch(/secret/i)
    }
  })
})
