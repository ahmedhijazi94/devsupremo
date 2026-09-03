import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  checkpointStatusFromReconcile,
  isReconcilable,
  reconcileProjectPr,
  resolveRequiredChecks,
  selectReconcilable,
} from './reconcile'
import { parseWebhookForReconcile } from './webhook'
import { reconcileCheckpointsForPr } from '@/lib/checkpoint/store'
import { humanCheckpointStatus } from '@/lib/checkpoint/restore'
import type { MergeGateway } from './merge-controller'
import type { CheckRun } from './merge-policy'

describe('seleção do fallback periódico', () => {
  it('isReconcilable só para estados relevantes', () => {
    expect(isReconcilable('ci_running')).toBe(true)
    expect(isReconcilable('merge_pending')).toBe(true)
    expect(isReconcilable('validated')).toBe(true)
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
    ]
    expect(selectReconcilable(projects).map((p) => p.id)).toEqual(['a', 'e'])
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
      getPullRequest: vi.fn(async () => ({ headSha: SHA, nodeId: 'n', merged: false, state: 'open' })),
      getChecks: vi.fn(async () => ({ checks: green, headSha: SHA })),
      allowAutoMerge: vi.fn(async () => true),
      enableNativeAutoMerge: vi.fn(async () => true),
      merge: vi.fn(async () => ({ sha: SHA })),
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
}

function fakeCheckpointsClient(rows: FakeCheckpointRow[]): SupabaseClient {
  function query() {
    let updatePayload: Record<string, unknown> | null = null
    const filters: Array<[string, unknown]> = []
    const builder = {
      update(payload: Record<string, unknown>) {
        updatePayload = payload
        return builder
      },
      eq(col: string, val: unknown) {
        filters.push([col, val])
        return builder
      },
      then(resolve: (v: { error: null }) => void) {
        const matches = rows.filter((r) =>
          filters.every(([col, val]) => (r as unknown as Record<string, unknown>)[col] === val),
        )
        if (updatePayload) {
          for (const row of matches) Object.assign(row, updatePayload)
        }
        resolve({ error: null })
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
        nodeId: 'n',
        merged: false,
        state: 'open',
      }),
      getChecks: async () => ({ checks: green, headSha: FINAL_HEAD_SHA }),
      allowAutoMerge: vi.fn(async () => true),
      enableNativeAutoMerge: vi.fn(async () => true),
      merge: vi.fn(async () => ({ sha: 'não deveria ser chamado' })),
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
      { projectId: PROJECT_ID, prNumber: PR_NUMBER },
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
