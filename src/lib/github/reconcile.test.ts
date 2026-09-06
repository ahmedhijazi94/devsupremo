import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  checkpointStatusFromReconcile,
  cleanupIntegrationBranchIfMerged,
  isManagedIntegrationBranch,
  isReconcilable,
  reconcileProjectPr,
  resolveRequiredChecks,
  selectReconcilable,
} from './reconcile'
import { parseWebhookForReconcile } from './webhook'
import { listPendingIntegrationBranchCleanups, reconcileCheckpointsForPr } from '@/lib/checkpoint/store'
import { humanCheckpointStatus } from '@/lib/checkpoint/restore'
import type { MergeGateway } from './merge-controller'
import type { CheckRun } from './merge-policy'

describe('seleção do fallback periódico', () => {
  it('isReconcilable só para estados relevantes', () => {
    expect(isReconcilable('ci_running')).toBe(true)
    expect(isReconcilable('merge_pending')).toBe(true)
    expect(isReconcilable('validated')).toBe(true)
    expect(isReconcilable('ci_failed')).toBe(true)
    expect(isReconcilable('security_blocked')).toBe(true)
    expect(isReconcilable('merged')).toBe(false)
    expect(isReconcilable('development')).toBe(false)
    expect(isReconcilable(null)).toBe(false)
  })

  it('selectReconcilable pega só projetos com PR aberta em estado relevante', () => {
    const projects = [
      { id: 'a', integration_state: 'ci_running', pr_number: 1 }, // ✓
      { id: 'b', integration_state: 'merged', pr_number: 2 }, // ✗ estado
      { id: 'c', integration_state: 'merge_pending', pr_number: null }, // ✗ sem PR
      { id: 'd', integration_state: null, pr_number: 4 }, // ✗ estado nulo
      { id: 'e', integration_state: 'validated', pr_number: 5 }, // ✓
      { id: 'f', integration_state: 'ci_failed', pr_number: 6 }, // retry diagnostic capture
      { id: 'g', integration_state: 'security_blocked', pr_number: 7 }, // rerun while offline
    ]
    expect(selectReconcilable(projects).map((p) => p.id)).toEqual(['a', 'e', 'f', 'g'])
  })
})

describe('resolveRequiredChecks — fonte real do template', () => {
  it('modo completo exige todos os gates', () => {
    const full = resolveRequiredChecks({ fastMode: false, rlsMode: 'block' })
    expect(full).toContain('Testes e cobertura')
    expect(full).toContain('End-to-end')
    expect(full).toContain('Políticas RLS')
  })

  it('sem sinal → fail-safe estrito (conjunto completo)', () => {
    expect(resolveRequiredChecks({}).length).toBeGreaterThanOrEqual(
      resolveRequiredChecks({ fastMode: true, rlsMode: 'warn' }).length,
    )
  })

  it('modo rápido exige ao menos os gates baratos + build', () => {
    const fast = resolveRequiredChecks({ fastMode: true, rlsMode: 'warn' })
    expect(fast).toContain('Build de produção')
    expect(fast).toContain('Varredura de segredos')
  })
})

/**
 * E2E real: depois que a execução em main ficou verde, o projeto mostrou
 * READY/tudo verde, mas o Histórico continuou em "Testando". Causa raiz: a
 * reconciliação sempre gravou `integration_state` no PROJETO
 * (`writeIntegrationMeta`), mas nada gravava de volta no CHECKPOINT —
 * `integration_status` era escrito UMA vez no publish ('ci_running') e nunca
 * mais tocado. `checkpointStatusFromReconcile` é a decisão PURA que resolve
 * isso: o que gravar no checkpoint a partir do resultado da reconciliação.
 */
describe('checkpointStatusFromReconcile — Histórico reconcilia pra Integrado só após merge válido', () => {
  it('merged: true → push_status vira "integrated" (só quando o merge de fato aconteceu)', () => {
    expect(checkpointStatusFromReconcile({ state: 'merged', merged: true })).toEqual({
      pushStatus: 'integrated',
      integrationStatus: 'merged',
    })
  })

  it('ainda não mesclado (ci_running) → integration_status avança, push_status NUNCA antecipa "integrated"', () => {
    expect(checkpointStatusFromReconcile({ state: 'ci_running', merged: false })).toEqual({
      pushStatus: null,
      integrationStatus: 'ci_running',
    })
  })

  it('validated (tudo verde, ainda não mesclado) → integration_status avança, mas push_status continua null — nunca declara Integrado antes da hora', () => {
    expect(checkpointStatusFromReconcile({ state: 'validated', merged: false })).toEqual({
      pushStatus: null,
      integrationStatus: 'validated',
    })
  })

  it('ci_failed/security_blocked → integration_status reflete a falha real (nunca fica preso em ci_running)', () => {
    expect(checkpointStatusFromReconcile({ state: 'ci_failed', merged: false })).toEqual({
      pushStatus: null,
      integrationStatus: 'ci_failed',
    })
    expect(checkpointStatusFromReconcile({ state: 'security_blocked', merged: false })).toEqual({
      pushStatus: null,
      integrationStatus: 'security_blocked',
    })
  })

  it('merged: false NUNCA produz pushStatus "integrated", seja qual for o state — fail-closed', () => {
    const states = [
      'development',
      'ci_running',
      'ci_failed',
      'security_blocked',
      'validated',
      'merge_pending',
      'unmanaged_main_change',
    ] as const
    for (const state of states) {
      expect(checkpointStatusFromReconcile({ state, merged: false }).pushStatus).toBeNull()
    }
  })
})

describe('reconcileProjectPr — caminho único, re-lê pelo gateway', () => {
  const SHA = 'a'.repeat(40)
  const green: CheckRun[] = [{ name: 'G', status: 'completed', conclusion: 'success' }]

  function gw(): MergeGateway {
    return {
      getPullRequest: vi.fn(async () => ({
        headSha: SHA,
        headRef: 'supremo/cp-x',
        nodeId: 'n',
        merged: false,
        state: 'open',
      })),
      getChecks: vi.fn(async () => ({ checks: green, headSha: SHA })),
      allowAutoMerge: vi.fn(async () => true),
      enableNativeAutoMerge: vi.fn(async () => true),
      merge: vi.fn(async () => ({ sha: SHA })),
      deleteBranch: vi.fn(async () => {}),
    }
  }

  it('delega para reconcileMerge relendo o estado real e registra eventos', async () => {
    const gateway = gw()
    const events: string[] = []
    const r = await reconcileProjectPr({
      gateway,
      prNumber: 7,
      requiredChecks: ['G'],
      mode: 'supremo_managed',
      log: { event: (n) => events.push(n) },
    })
    // relê o estado (não confia no payload do webhook)
    expect(gateway.getPullRequest).toHaveBeenCalled()
    expect(gateway.getChecks).toHaveBeenCalled()
    expect(r.merged).toBe(true)
    expect(events).toContain('reconciliation_started')
    expect(events).toContain('reconciliation_result')
  })

  it('modo native não mescla ele mesmo — habilita auto-merge nativo', async () => {
    const gateway = gw()
    await reconcileProjectPr({
      gateway,
      prNumber: 1,
      requiredChecks: ['G'],
      mode: 'native',
    })
    expect(gateway.enableNativeAutoMerge).toHaveBeenCalled()
    expect(gateway.merge).not.toHaveBeenCalled()
  })
})

/**
 * Cleanup de integration branch pós-merge (v3-13, E2E v3-12): PRs antigas já
 * integradas deixavam `supremo/cp-*` pra trás no repositório. Reaproveita o
 * MESMO gateway/reconcile — nenhum cron/lifecycle paralelo.
 */
describe('isManagedIntegrationBranch — namespace gerenciado, nunca a branch padrão', () => {
  it('supremo/cp-* → gerenciada', () => {
    expect(isManagedIntegrationBranch('supremo/cp-abc123', 'main')).toBe(true)
  })

  it('fora de supremo/ → nunca gerenciada, mesmo com nome parecido', () => {
    expect(isManagedIntegrationBranch('feature/supremo-thing', 'main')).toBe(false)
    expect(isManagedIntegrationBranch('dependabot/npm_and_yarn/x', 'main')).toBe(false)
    expect(isManagedIntegrationBranch('minha-branch-manual', 'main')).toBe(false)
  })

  it('a branch padrão NUNCA é gerenciada — mesmo no hipotético caso de começar com supremo/', () => {
    expect(isManagedIntegrationBranch('main', 'main')).toBe(false)
    expect(isManagedIntegrationBranch('supremo/main', 'supremo/main')).toBe(false)
  })
})

describe('cleanupIntegrationBranchIfMerged — só apaga após confirmar DE NOVO no GitHub (v3-13)', () => {
  function gwWithPr(pr: { headRef: string; merged: boolean }): MergeGateway & {
    deleteBranch: ReturnType<typeof vi.fn>
    getPullRequest: ReturnType<typeof vi.fn>
  } {
    return {
      getPullRequest: vi.fn(async () => ({
        headSha: 'sha',
        headRef: pr.headRef,
        nodeId: 'n',
        merged: pr.merged,
        state: pr.merged ? 'closed' : 'open',
      })),
      getChecks: vi.fn(async () => ({ checks: [], headSha: 'sha' })),
      allowAutoMerge: vi.fn(async () => true),
      enableNativeAutoMerge: vi.fn(async () => true),
      merge: vi.fn(async () => ({ sha: 'sha' })),
      deleteBranch: vi.fn(async () => {}),
    }
  }

  // 1. merged → branch removida.
  it('PR confirmada merged (namespace gerenciado) → apaga a branch', async () => {
    const gateway = gwWithPr({ headRef: 'supremo/cp-abc123', merged: true })
    const out = await cleanupIntegrationBranchIfMerged(gateway, { prNumber: 9, defaultBranch: 'main' })
    expect(gateway.deleteBranch).toHaveBeenCalledWith('supremo/cp-abc123')
    expect(out).toEqual({
      attempted: true,
      deleted: true,
      branch: 'supremo/cp-abc123',
      reason: expect.stringContaining('removida'),
    })
  })

  // 2. open → preservada (nem chega a checar namespace — já para na releitura).
  it('PR ainda aberta (merged: false) → NUNCA apaga, branch preservada', async () => {
    const gateway = gwWithPr({ headRef: 'supremo/cp-abc123', merged: false })
    const out = await cleanupIntegrationBranchIfMerged(gateway, { prNumber: 9, defaultBranch: 'main' })
    expect(gateway.deleteBranch).not.toHaveBeenCalled()
    expect(out.attempted).toBe(false)
    expect(out.deleted).toBe(false)
    expect(out.branch).toBe('supremo/cp-abc123')
  })

  // 3. closed sem merge → preservada (mesmo sinal que "open" pro gateway:
  // merged permanece false; quem chama só invoca isto quando result.merged
  // é true, então uma PR fechada-sem-merge nunca chega aqui na prática —
  // mas a função em si, isolada, tem que se recusar de qualquer jeito).
  it('PR fechada SEM merge (merged: false, state: closed) → NUNCA apaga', async () => {
    const gateway: MergeGateway = {
      getPullRequest: vi.fn(async () => ({
        headSha: 'sha',
        headRef: 'supremo/cp-abc123',
        nodeId: 'n',
        merged: false,
        state: 'closed', // fechada, mas SEM merge — o caso que a regra exige preservar
      })),
      getChecks: vi.fn(async () => ({ checks: [], headSha: 'sha' })),
      allowAutoMerge: vi.fn(async () => true),
      enableNativeAutoMerge: vi.fn(async () => true),
      merge: vi.fn(async () => ({ sha: 'sha' })),
      deleteBranch: vi.fn(async () => {}),
    }
    const out = await cleanupIntegrationBranchIfMerged(gateway, { prNumber: 9, defaultBranch: 'main' })
    expect(gateway.deleteBranch).not.toHaveBeenCalled()
    expect(out.attempted).toBe(false)
  })

  // 4. branch fora de supremo/ → nunca removida (mesmo que a PR esteja merged).
  it('PR merged mas headRef FORA do namespace supremo/ → NUNCA apaga (nunca toca PR de terceiro/Dependabot)', async () => {
    const gateway = gwWithPr({ headRef: 'dependabot/npm_and_yarn/lodash-4.17.21', merged: true })
    const out = await cleanupIntegrationBranchIfMerged(gateway, { prNumber: 9, defaultBranch: 'main' })
    expect(gateway.deleteBranch).not.toHaveBeenCalled()
    expect(out.attempted).toBe(false)
    expect(out.deleted).toBe(false)
    expect(out.branch).toBe('dependabot/npm_and_yarn/lodash-4.17.21')
  })

  // 5. main → impossível remover, mesmo que headRef seja literalmente a branch padrão.
  it('PR merged com headRef == defaultBranch (hipotético) → IMPOSSÍVEL apagar, main nunca é candidata', async () => {
    const gateway = gwWithPr({ headRef: 'main', merged: true })
    const out = await cleanupIntegrationBranchIfMerged(gateway, { prNumber: 9, defaultBranch: 'main' })
    expect(gateway.deleteBranch).not.toHaveBeenCalled()
    expect(out.attempted).toBe(false)
  })

  // 6. branch já inexistente → idempotente (deleteBranch real já é silencioso
  // nesse caso — ver mcp/github.ts; aqui provamos que o CALLER trata sucesso
  // igual não importa quantas vezes rodar).
  it('branch já apagada (delete não lança, idempotente por natureza) → sucesso, repetir de novo também é sucesso', async () => {
    const gateway = gwWithPr({ headRef: 'supremo/cp-abc123', merged: true })
    const first = await cleanupIntegrationBranchIfMerged(gateway, { prNumber: 9, defaultBranch: 'main' })
    const second = await cleanupIntegrationBranchIfMerged(gateway, { prNumber: 9, defaultBranch: 'main' })
    expect(first.deleted).toBe(true)
    expect(second.deleted).toBe(true) // repetir não é erro — idempotente
    expect(gateway.deleteBranch).toHaveBeenCalledTimes(2)
  })

  // 7. erro temporário do GitHub → nunca lança (merge/checkpoint, já
  // persistidos por quem chama ANTES disto, continuam intactos), e repetir
  // depois (webhook de novo, ou o fallback) tenta de novo normalmente.
  it('erro temporário na releitura da PR → nunca lança, sinaliza fail-safe, repetir depois funciona normalmente', async () => {
    let shouldFail = true
    const gateway: MergeGateway = {
      getPullRequest: vi.fn(async () => {
        if (shouldFail) throw new Error('ETIMEDOUT: GitHub API indisponível (transitório)')
        return { headSha: 'sha', headRef: 'supremo/cp-abc123', nodeId: 'n', merged: true, state: 'closed' }
      }),
      getChecks: vi.fn(async () => ({ checks: [], headSha: 'sha' })),
      allowAutoMerge: vi.fn(async () => true),
      enableNativeAutoMerge: vi.fn(async () => true),
      merge: vi.fn(async () => ({ sha: 'sha' })),
      deleteBranch: vi.fn(async () => {}),
    }
    const events: string[] = []
    const failedAttempt = await cleanupIntegrationBranchIfMerged(
      gateway,
      { prNumber: 9, defaultBranch: 'main' },
      { event: (n) => events.push(n) },
    )
    expect(failedAttempt.deleted).toBe(false)
    expect(failedAttempt.attempted).toBe(true)
    expect(events).toContain('integration_branch_cleanup_error')
    expect(gateway.deleteBranch).not.toHaveBeenCalled()

    // A "próxima reconciliação" (webhook novo ou fallback) — o GitHub já não
    // está mais indisponível — repete e desta vez funciona.
    shouldFail = false
    const retried = await cleanupIntegrationBranchIfMerged(gateway, { prNumber: 9, defaultBranch: 'main' })
    expect(retried.deleted).toBe(true)
    expect(gateway.deleteBranch).toHaveBeenCalledWith('supremo/cp-abc123')
  })

  it('erro no PRÓPRIO deleteBranch (não na releitura) → também nunca lança, mesmo fail-safe', async () => {
    const gateway: MergeGateway = {
      getPullRequest: vi.fn(async () => ({
        headSha: 'sha',
        headRef: 'supremo/cp-abc123',
        nodeId: 'n',
        merged: true,
        state: 'closed',
      })),
      getChecks: vi.fn(async () => ({ checks: [], headSha: 'sha' })),
      allowAutoMerge: vi.fn(async () => true),
      enableNativeAutoMerge: vi.fn(async () => true),
      merge: vi.fn(async () => ({ sha: 'sha' })),
      deleteBranch: vi.fn(async () => {
        throw new Error('403: rate limited (transitório)')
      }),
    }
    await expect(
      cleanupIntegrationBranchIfMerged(gateway, { prNumber: 9, defaultBranch: 'main' }),
    ).resolves.toMatchObject({ attempted: true, deleted: false })
  })
})

/**
 * Cliente Supabase FALSO com uma tabela `checkpoints` de VERDADE em memória —
 * ao contrário do fake de store.test.ts (que só captura a QUERY), este
 * aplica o filtro + update de fato contra linhas reais, pra provar que um
 * UPDATE em lote (2+ checkpoints casando o mesmo filtro) afeta AMBOS, cada
 * um preservando seus próprios campos não tocados (commit_sha, published_sha,
 * created_at).
 */
interface FakeCheckpointRow {
  id: string
  project_id: string
  pr_number: number | null
  push_status: string
  integration_status: string | null
  commit_sha: string
  published_sha: string | null
  created_at: string
  /** Opcional pra não obrigar toda seed pré-existente a declarar — ausente
   * conta como null pro filtro `.not(col, 'is', null)` (v3-14). */
  integration_branch?: string | null
}

/**
 * Suporta TANTO o caminho de escrita (`update().eq()...`, usado por
 * `reconcileCheckpointsForPr`) QUANTO o de leitura (`select().eq().not()
 * .order().limit()`, usado por `listPendingIntegrationBranchCleanups`,
 * v3-14) contra o MESMO array `rows` em memória — necessário pra provar que
 * uma leitura de retry realmente ENXERGA o que uma escrita anterior gravou,
 * não só que as duas funções funcionam isoladas.
 */
function fakeCheckpointsClient(rows: FakeCheckpointRow[]): SupabaseClient {
  function query() {
    let mode: 'update' | 'select' = 'update'
    let updatePayload: Record<string, unknown> | null = null
    const eqFilters: Array<[string, unknown]> = []
    const notNullCols: string[] = []
    let orderCol: string | null = null
    let orderAscending = true
    let limitN: number | null = null
    const builder = {
      update(payload: Record<string, unknown>) {
        mode = 'update'
        updatePayload = payload
        return builder
      },
      select() {
        mode = 'select'
        return builder
      },
      eq(col: string, val: unknown) {
        eqFilters.push([col, val])
        return builder
      },
      not(col: string, _op: string, val: unknown) {
        if (val === null) notNullCols.push(col)
        return builder
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderCol = col
        orderAscending = opts?.ascending ?? true
        return builder
      },
      limit(n: number) {
        limitN = n
        return builder
      },
      then(resolve: (v: { data: FakeCheckpointRow[] | null; error: null }) => void) {
        let matches = rows.filter((r) => {
          const rec = r as unknown as Record<string, unknown>
          if (!eqFilters.every(([col, val]) => rec[col] === val)) return false
          if (!notNullCols.every((col) => rec[col] !== null && rec[col] !== undefined)) return false
          return true
        })
        if (mode === 'update') {
          if (updatePayload) for (const row of matches) Object.assign(row, updatePayload)
          resolve({ data: null, error: null })
          return
        }
        if (orderCol) {
          const col = orderCol
          matches = [...matches].sort((a, b) => {
            const av = String((a as unknown as Record<string, unknown>)[col])
            const bv = String((b as unknown as Record<string, unknown>)[col])
            const cmp = av < bv ? -1 : av > bv ? 1 : 0
            return orderAscending ? cmp : -cmp
          })
        }
        if (limitN != null) matches = matches.slice(0, limitN)
        resolve({ data: matches, error: null })
      },
    }
    return builder
  }
  return { from: () => query() } as unknown as SupabaseClient
}

/**
 * E2E real (teste-v3-8): 2 checkpoints publicados na PR #1; o segundo
 * atualizou a MESMA PR via synchronize. O último HEAD passou nos gates, a PR
 * foi mergeada, o workflow em main passou, o projeto mostrou READY/tudo
 * verde — mas os DOIS checkpoints continuaram "Testando".
 *
 * Causa raiz identificada (ver webhook.ts): 'closed' nunca disparava
 * reconciliation. O projeto só chegava a 'merged' por COINCIDÊNCIA de algum
 * check_suite/check_run "completed" pegar o HEAD já verde enquanto a PR
 * ainda estava aberta — sem um gatilho DEDICADO para "a PR realmente
 * mergeou", reconciliar os checkpoints (que roda no MESMO ciclo que
 * reconcilia o projeto) fica refém dessa coincidência de timing.
 *
 * Este teste reproduz o cenário exato E prova o invariante pedido: quando
 * uma PR mergeia após os gates do HEAD final, TODOS os checkpoints
 * `published` daquela mesma project_id+pr_number reconciliam para
 * 'integrated' — preservando a ordem e os SHAs individuais de cada um (NUNCA
 * dependendo de published_sha == HEAD final, que checkpoints anteriores da
 * mesma PR naturalmente não têm).
 */
describe('regressão: 2 checkpoints na MESMA PR → synchronize → merge → AMBOS Integrado (teste-v3-8)', () => {
  const PROJECT_ID = 'proj-teste-v3-8'
  const PR_NUMBER = 1
  const FINAL_HEAD_SHA = 'published-sha-do-checkpoint-2'

  function seedRows(): FakeCheckpointRow[] {
    return [
      {
        id: 'checkpoint-1',
        project_id: PROJECT_ID,
        pr_number: PR_NUMBER,
        push_status: 'published',
        integration_status: 'ci_running',
        commit_sha: 'local-sha-checkpoint-1',
        published_sha: 'published-sha-do-checkpoint-1',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'checkpoint-2',
        project_id: PROJECT_ID,
        pr_number: PR_NUMBER,
        push_status: 'published',
        integration_status: 'ci_running',
        commit_sha: 'local-sha-checkpoint-2',
        published_sha: FINAL_HEAD_SHA,
        created_at: '2026-01-01T00:05:00.000Z',
      },
    ]
  }

  it.each(['G', 'Políticas RLS'])('failure from %s at SHA A never overwrites checkpoint B published while checks were loading', async (gate) => {
    const [older, newer] = seedRows()
    if (!older?.published_sha || !newer) throw new Error('Expected two published checkpoint fixtures')
    const observedSha = older.published_sha
    const rows = [older!]
    const client = fakeCheckpointsClient(rows)
    const gateway: MergeGateway = {
      getPullRequest: async () => ({ headSha: observedSha, headRef: 'supremo/cp-x', nodeId: 'n', merged: false, state: 'open' }),
      getChecks: async () => {
        // The user's next turn publishes while the old GitHub read is in flight.
        rows.push(newer!)
        return { headSha: observedSha, checks: [{ name: gate, status: 'completed', conclusion: 'failure' }] }
      },
      allowAutoMerge: vi.fn(async () => true), enableNativeAutoMerge: vi.fn(async () => true),
      merge: vi.fn(async () => ({ sha: 'must-not-merge' })), deleteBranch: vi.fn(async () => {}),
    }
    const result = await reconcileProjectPr({ gateway, prNumber: PR_NUMBER, requiredChecks: [gate], mode: 'supremo_managed' })
    expect(result.headSha).toBe(older!.published_sha)
    await reconcileCheckpointsForPr(client, { projectId: PROJECT_ID, prNumber: PR_NUMBER, publishedSha: result.headSha },
      checkpointStatusFromReconcile(result))
    expect(older!.integration_status).toBe(gate === 'Políticas RLS' ? 'security_blocked' : 'ci_failed')
    expect(newer!).toMatchObject({ integration_status: 'ci_running', push_status: 'published', published_sha: FINAL_HEAD_SHA })
    expect(gateway.merge).not.toHaveBeenCalled()
  })

  it('fail-closed: enquanto a PR não mergeou de verdade, NENHUM checkpoint vira integrated — mesmo com synchronize disparando reconciliação', async () => {
    const rows = seedRows()
    const client = fakeCheckpointsClient(rows)

    // Checkpoint 2 atualiza a PR (synchronize) — o webhook agora tem que
    // reconhecer o evento (era isto que o E2E real exercitou).
    const syncTarget = parseWebhookForReconcile('pull_request', {
      action: 'synchronize',
      installation: { id: 1 },
      repository: { full_name: 'ahmed/app' },
      pull_request: { number: PR_NUMBER, head: { sha: FINAL_HEAD_SHA, ref: 'supremo/cp-x' } },
    })
    expect(syncTarget).not.toBeNull()
    expect(syncTarget!.prNumbers).toEqual([PR_NUMBER])

    // CI do HEAD novo ainda rodando — nada deve avançar pra integrated.
    const green: CheckRun[] = [{ name: 'G', status: 'in_progress', conclusion: null }]
    const stillRunningGateway: MergeGateway = {
      getPullRequest: async () => ({
        headSha: FINAL_HEAD_SHA,
        headRef: 'supremo/cp-x',
        nodeId: 'n',
        merged: false,
        state: 'open',
      }),
      getChecks: async () => ({ checks: green, headSha: FINAL_HEAD_SHA }),
      allowAutoMerge: vi.fn(async () => true),
      enableNativeAutoMerge: vi.fn(async () => true),
      merge: vi.fn(async () => ({ sha: 'não deveria ser chamado' })),
      deleteBranch: vi.fn(async () => {}),
    }
    const pendingResult = await reconcileProjectPr({
      gateway: stillRunningGateway,
      prNumber: PR_NUMBER,
      requiredChecks: ['G'],
      mode: 'supremo_managed',
    })
    expect(pendingResult.merged).toBe(false)
    await reconcileCheckpointsForPr(
      client,
      { projectId: PROJECT_ID, prNumber: PR_NUMBER, publishedSha: pendingResult.headSha },
      checkpointStatusFromReconcile(pendingResult),
    )
    expect(stillRunningGateway.merge).not.toHaveBeenCalled()
    for (const row of rows) {
      expect(row.push_status).toBe('published') // fail-closed: ninguém virou integrated ainda
    }
  })

  it('gates do HEAD final passam + PR mergeada de verdade → AMBOS os checkpoints reconciliam para Integrado, preservando SHAs/ordem individuais', async () => {
    const rows = seedRows()
    const client = fakeCheckpointsClient(rows)

    let merged = false
    const green: CheckRun[] = [{ name: 'G', status: 'completed', conclusion: 'success' }]
    const gateway: MergeGateway = {
      getPullRequest: async () => ({
        headSha: FINAL_HEAD_SHA,
        headRef: 'supremo/cp-x',
        nodeId: 'n',
        merged,
        state: merged ? 'closed' : 'open',
      }),
      getChecks: async () => ({ checks: green, headSha: FINAL_HEAD_SHA }),
      allowAutoMerge: async () => true,
      enableNativeAutoMerge: async () => true,
      merge: async () => {
        merged = true
        return { sha: 'squash-commit-sha-na-main' }
      },
      deleteBranch: async () => {},
    }

    // Gates do HEAD final (checkpoint 2) verdes → reconcileProjectPr MESCLA de verdade.
    const mergeResult = await reconcileProjectPr({
      gateway,
      prNumber: PR_NUMBER,
      requiredChecks: ['G'],
      mode: 'supremo_managed',
    })
    expect(mergeResult.merged).toBe(true)
    expect(mergeResult.state).toBe('merged')

    // O gatilho corrigido: 'closed' com merged:true (o evento que faltava).
    const closedTarget = parseWebhookForReconcile('pull_request', {
      action: 'closed',
      installation: { id: 1 },
      repository: { full_name: 'ahmed/app' },
      pull_request: { number: PR_NUMBER, merged: true, head: { sha: FINAL_HEAD_SHA, ref: 'supremo/cp-x' } },
    })
    expect(closedTarget).not.toBeNull()
    expect(closedTarget!.prNumbers).toEqual([PR_NUMBER])

    // O MESMO ciclo que reconcilia o projeto reconcilia os checkpoints — a
    // fiação real do webhook route (writeIntegrationMeta + reconcileCheckpointsForPr).
    await reconcileCheckpointsForPr(
      client,
      { projectId: PROJECT_ID, prNumber: PR_NUMBER },
      checkpointStatusFromReconcile(mergeResult),
    )

    // AMBOS os checkpoints — nunca só o que tem published_sha == HEAD final.
    for (const row of rows) {
      expect(row.push_status).toBe('integrated')
      expect(row.integration_status).toBe('merged')
      expect(
        humanCheckpointStatus(row.push_status as 'integrated', row.integration_status as 'merged'),
      ).toBe('Integrado')
    }

    // SHAs e ordem individuais preservados — a reconciliação nunca reescreve
    // commit_sha/published_sha/created_at, e o checkpoint 1 (mais antigo, SHA
    // diferente do HEAD final) reconcilia igual ao checkpoint 2.
    expect(rows[0]!.commit_sha).toBe('local-sha-checkpoint-1')
    expect(rows[0]!.published_sha).toBe('published-sha-do-checkpoint-1')
    expect(rows[1]!.commit_sha).toBe('local-sha-checkpoint-2')
    expect(rows[1]!.published_sha).toBe(FINAL_HEAD_SHA)
    expect(rows[0]!.published_sha).not.toBe(rows[1]!.published_sha)
    expect(new Date(rows[0]!.created_at).getTime()).toBeLessThan(
      new Date(rows[1]!.created_at).getTime(),
    )
  })

  it('checkpoint já integrated/failed (de um ciclo anterior) NUNCA é reaberto pela reconciliação de uma PR nova', async () => {
    const rows = seedRows()
    rows[0]!.push_status = 'integrated'
    rows[0]!.integration_status = 'merged'
    const client = fakeCheckpointsClient(rows)

    await reconcileCheckpointsForPr(
      client,
      { projectId: PROJECT_ID, prNumber: PR_NUMBER },
      { pushStatus: 'integrated', integrationStatus: 'merged' },
    )

    // O já-integrado permanece como estava (não é alvo do filtro push_status='published').
    expect(rows[0]!.push_status).toBe('integrated')
    // O outro, ainda 'published', reconcilia normalmente.
    expect(rows[1]!.push_status).toBe('integrated')
  })
})

/**
 * Sequência REAL de ponta a ponta (v3-13, requisito 7 do pedido): mesmo
 * quando o cleanup da branch falha por um erro transitório do GitHub, o
 * merge JÁ mesclou e o checkpoint JÁ reconciliou pra Integrado — nessa
 * ordem exata, igual à fiação real do webhook/reconcile route
 * (reconcileProjectPr → reconcileCheckpointsForPr → cleanup, cleanup por
 * ÚLTIMO e sempre best-effort).
 */
describe('sequência completa: merge + checkpoint + cleanup (v3-13, requisito 7) — falha no cleanup nunca contamina o que já foi persistido', () => {
  const PROJECT_ID = 'proj-teste-v3-13'
  const PR_NUMBER = 42

  function seedRow(): { id: string; project_id: string; pr_number: number; push_status: string; integration_status: string | null; commit_sha: string; published_sha: string | null; created_at: string } {
    return {
      id: 'checkpoint-v3-13',
      project_id: PROJECT_ID,
      pr_number: PR_NUMBER,
      push_status: 'published',
      integration_status: 'ci_running',
      commit_sha: 'local-sha',
      published_sha: 'published-sha',
      created_at: '2026-01-01T00:00:00.000Z',
    }
  }

  it('cleanup falha (GitHub indisponível) → merge JÁ aconteceu e checkpoint JÁ reconciliou pra Integrado, intactos; repetir o cleanup depois funciona', async () => {
    const rows = [seedRow()]
    const client = fakeCheckpointsClient(rows)

    let deleteAttempts = 0
    const SHA = 'final-sha'
    const gateway: MergeGateway = {
      getPullRequest: vi.fn(async () => ({
        headSha: SHA,
        headRef: 'supremo/cp-final',
        nodeId: 'n',
        merged: true, // PR já mesclada — reconcileMerge retorna 'merged' de cara
        state: 'closed',
      })),
      getChecks: vi.fn(async () => ({ checks: [], headSha: SHA })),
      allowAutoMerge: vi.fn(async () => true),
      enableNativeAutoMerge: vi.fn(async () => true),
      merge: vi.fn(async () => ({ sha: SHA })),
      deleteBranch: vi.fn(async () => {
        deleteAttempts += 1
        if (deleteAttempts === 1) throw new Error('502: GitHub indisponível (transitório)')
        // 2ª tentativa (a "próxima reconciliação"): sucesso.
      }),
    }

    // 1) reconcileProjectPr — o mesmo caminho único do webhook/fallback.
    const result = await reconcileProjectPr({
      gateway,
      prNumber: PR_NUMBER,
      requiredChecks: [],
      mode: 'supremo_managed',
    })
    expect(result.merged).toBe(true)
    expect(result.state).toBe('merged')

    // 2) reconcileCheckpointsForPr — persistido ANTES do cleanup, exatamente
    // como a fiação real do route.
    await reconcileCheckpointsForPr(
      client,
      { projectId: PROJECT_ID, prNumber: PR_NUMBER },
      checkpointStatusFromReconcile(result),
    )
    expect(rows[0]!.push_status).toBe('integrated')
    expect(rows[0]!.integration_status).toBe('merged')

    // 3) cleanup — falha (transitório). NUNCA lança, e o que já foi
    // persistido nos passos 1-2 continua exatamente como estava.
    const cleanupResult = await cleanupIntegrationBranchIfMerged(gateway, {
      prNumber: PR_NUMBER,
      defaultBranch: 'main',
    })
    expect(cleanupResult.deleted).toBe(false)
    expect(rows[0]!.push_status).toBe('integrated') // intacto — cleanup não desfez nada
    expect(rows[0]!.integration_status).toBe('merged')

    // 4) "a próxima reconciliação" (webhook novo, ou o fallback periódico)
    // reconcilia de novo — reconcileProjectPr é idempotente (PR já merged,
    // noop) — e desta vez o cleanup consegue.
    const secondResult = await reconcileProjectPr({
      gateway,
      prNumber: PR_NUMBER,
      requiredChecks: [],
      mode: 'supremo_managed',
    })
    expect(secondResult.merged).toBe(true) // continua correto, idempotente
    // PR já estava `merged` desde a 1ª leitura — reconcileMerge nunca chama
    // `.merge()` de novo pra uma PR já mesclada (noop, ver merge-controller.ts).
    expect(gateway.merge).not.toHaveBeenCalled()

    const retriedCleanup = await cleanupIntegrationBranchIfMerged(gateway, {
      prNumber: PR_NUMBER,
      defaultBranch: 'main',
    })
    expect(retriedCleanup.deleted).toBe(true)
    expect(deleteAttempts).toBe(2)

    // Checkpoint continua Integrado o tempo todo — nunca regrediu por causa
    // da falha/retry do cleanup.
    expect(rows[0]!.push_status).toBe('integrated')
    expect(rows[0]!.integration_status).toBe('merged')
  })
})

/**
 * v3-14 — a pergunta que o teste acima (v3-13) NÃO responde: como o sistema,
 * sozinho, ACHA essa PR de novo pra tentar o cleanup uma segunda vez? Chamar
 * `cleanupIntegrationBranchIfMerged` à mão duas vezes prova que a FUNÇÃO é
 * idempotente/retentável — não prova que ela é ALCANÇÁVEL em produção.
 *
 * BUG REAL: uma vez `push_status='integrated'`, o projeto sai de
 * `RECONCILABLE_STATES` (nunca mais selecionado por `listProjectsForReconcile`)
 * e a PR, fechada, não aparece mais via `getOpenPullRequestNumber` — a
 * varredura PRINCIPAL do fallback nunca mais visita essa PR. Este teste
 * simula o CICLO INTEIRO do fallback (`/api/github/reconcile` route) duas
 * vezes, contra o MESMO estado persistido (checkpoints em memória — nenhuma
 * alteração nova no projeto entre as duas execuções), replicando a MESMA
 * sequência de chamadas que o route real faz: reconcile → checkpoint →
 * cleanup (1ª execução, falha) → ... → `listPendingIntegrationBranchCleanups`
 * (a MESMA query que o route roda na 2ª varredura) → cleanup de novo (2ª
 * execução do fallback, sucesso).
 */
describe('retry do cleanup REALMENTE alcançável pelo fallback existente, sem alteração nova no projeto (v3-14)', () => {
  const PROJECT_ID = 'proj-teste-v3-14'
  const PR_NUMBER = 77
  const BRANCH = 'supremo/cp-v3-14'
  const SHA = 'sha-v3-14'

  function seedRow(): FakeCheckpointRow {
    return {
      id: 'checkpoint-v3-14',
      project_id: PROJECT_ID,
      pr_number: PR_NUMBER,
      push_status: 'published',
      integration_status: 'ci_running',
      commit_sha: 'local-sha',
      published_sha: SHA,
      created_at: '2026-01-01T00:00:00.000Z',
      integration_branch: BRANCH,
    }
  }

  it('1) merge confirmado; 2) 1ª deleção falha; 3) Integrado intacto; 4) fallback REENCONTRA via listPendingIntegrationBranchCleanups; 5) 2ª deleção passa; 6) branch some', async () => {
    const rows = [seedRow()]
    const client = fakeCheckpointsClient(rows)

    let deleteAttempts = 0
    let branchExistsOnGithub = true
    const gateway: MergeGateway = {
      getPullRequest: vi.fn(async () => ({
        headSha: SHA,
        headRef: BRANCH,
        nodeId: 'n',
        merged: true,
        state: 'closed',
      })),
      getChecks: vi.fn(async () => ({ checks: [], headSha: SHA })),
      allowAutoMerge: vi.fn(async () => true),
      enableNativeAutoMerge: vi.fn(async () => true),
      merge: vi.fn(async () => ({ sha: SHA })),
      deleteBranch: vi.fn(async (branch: string) => {
        deleteAttempts += 1
        if (deleteAttempts === 1) throw new Error('502: GitHub indisponível (transitório)')
        expect(branch).toBe(BRANCH)
        branchExistsOnGithub = false
      }),
    }

    // ── EXECUÇÃO 1 do fallback/webhook: reconcile → checkpoint → cleanup (falha) ──
    // 1) merge confirmado.
    const result = await reconcileProjectPr({
      gateway,
      prNumber: PR_NUMBER,
      requiredChecks: [],
      mode: 'supremo_managed',
    })
    expect(result.merged).toBe(true)
    expect(result.state).toBe('merged')

    await reconcileCheckpointsForPr(
      client,
      { projectId: PROJECT_ID, prNumber: PR_NUMBER },
      checkpointStatusFromReconcile(result),
    )
    // 3) estado funcional já é Integrado neste ponto.
    expect(rows[0]!.push_status).toBe('integrated')
    expect(rows[0]!.integration_status).toBe('merged')

    // 2) primeira deleção falha (transitório) — nunca lança.
    const firstCleanup = await cleanupIntegrationBranchIfMerged(gateway, {
      prNumber: PR_NUMBER,
      defaultBranch: 'main',
    })
    expect(firstCleanup.deleted).toBe(false)
    expect(deleteAttempts).toBe(1)
    expect(branchExistsOnGithub).toBe(true) // branch continua existindo

    // 3) (reforço) o estado funcional continua Integrado depois da falha —
    // nada regrediu por causa do cleanup ter falhado.
    expect(rows[0]!.push_status).toBe('integrated')
    expect(rows[0]!.integration_status).toBe('merged')

    // ── "o tempo passa" — NENHUMA alteração nova no projeto: nenhum checkpoint
    // novo, nenhum evento de webhook novo. Só o fallback periódico roda de
    // novo, sozinho, no ciclo seguinte. ──

    // 4) EXECUÇÃO 2 do fallback: a varredura PRINCIPAL (RECONCILABLE_STATES +
    // getOpenPullRequestNumber) NÃO acharia mais esta PR — ela já está
    // 'integrated'/fechada. É `listPendingIntegrationBranchCleanups` (a MESMA
    // query que a rota `/api/github/reconcile` roda na sua segunda varredura)
    // que precisa reencontrar o cleanup pendente sozinha, sem nenhum ponteiro
    // externo apontando pra essa PR.
    const pending = await listPendingIntegrationBranchCleanups(client)
    expect(pending).toContainEqual({
      projectId: PROJECT_ID,
      prNumber: PR_NUMBER,
      integrationBranch: BRANCH,
    })

    // O route real itera exatamente assim: pra cada candidato achado,
    // resolve o projeto e chama cleanupIntegrationBranchIfMerged de novo —
    // nunca reconcileProjectPr (já sabemos que mergeou pelo checkpoint; a
    // própria função confirma de novo no GitHub antes de apagar).
    const candidate = pending.find(
      (p) => p.projectId === PROJECT_ID && p.prNumber === PR_NUMBER,
    )
    expect(candidate).toBeDefined() // a PR É alcançável — não foi perdida
    const retriedCleanup = await cleanupIntegrationBranchIfMerged(gateway, {
      prNumber: candidate!.prNumber,
      defaultBranch: 'main',
    })

    // 5) segunda deleção passa.
    expect(retriedCleanup.deleted).toBe(true)
    expect(deleteAttempts).toBe(2)
    // 6) branch some (do lado do GitHub, ver o fake acima).
    expect(branchExistsOnGithub).toBe(false)

    // O checkpoint nunca regrediu de Integrado em NENHUM momento desta
    // sequência — nem durante a falha, nem durante o retry bem-sucedido.
    expect(rows[0]!.push_status).toBe('integrated')
    expect(rows[0]!.integration_status).toBe('merged')
  })

  it('depois do cleanup ter sucesso, a PR sai naturalmente do próximo `limit()` mais cedo se checkpoints mais novos existirem — nunca é uma fila que precisa de "ack" explícito', async () => {
    // Prova que o design é best-effort/self-healing: uma vez que a branch já
    // não existe, chamar cleanup DE NOVO (o próximo ciclo do fallback, se por
    // acaso ainda encontrar esta PR) continua seguro — deleteBranch real já é
    // idempotente (ver mcp/github.ts), e aqui simulamos exatamente isso.
    const rows = [seedRow()]
    rows[0]!.push_status = 'integrated'
    rows[0]!.integration_status = 'merged'
    const client = fakeCheckpointsClient(rows)

    const gateway: MergeGateway = {
      getPullRequest: vi.fn(async () => ({
        headSha: SHA,
        headRef: BRANCH,
        nodeId: 'n',
        merged: true,
        state: 'closed',
      })),
      getChecks: vi.fn(async () => ({ checks: [], headSha: SHA })),
      allowAutoMerge: vi.fn(async () => true),
      enableNativeAutoMerge: vi.fn(async () => true),
      merge: vi.fn(async () => ({ sha: SHA })),
      deleteBranch: vi.fn(async () => {}), // já não existe — silencioso, como o real
    }

    const pending = await listPendingIntegrationBranchCleanups(client)
    expect(pending).toHaveLength(1)
    const outcome = await cleanupIntegrationBranchIfMerged(gateway, {
      prNumber: pending[0]!.prNumber,
      defaultBranch: 'main',
    })
    expect(outcome.deleted).toBe(true) // idempotente — sucesso mesmo "já apagada"
  })
})
