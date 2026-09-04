import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { listPendingIntegrationBranchCleanups, reconcileCheckpointsForPr } from './store'

/**
 * E2E real: o Histórico ficou preso em "Testando" mesmo depois de um merge
 * válido — a reconciliação nunca escrevia de volta no checkpoint. Este
 * arquivo fica fora da métrica de cobertura (I/O puro sobre Supabase — ver
 * vitest.config.ts), mas `reconcileCheckpointsForPr` é simples o bastante
 * para confirmar, sem rede, que a QUERY que ele monta é exatamente a certa:
 * escopada ao projeto + PR certos, e só toca checkpoints ainda 'published'
 * (nunca reabre um 'integrated'/'failed' já resolvido, nunca vaza pra outro
 * projeto/PR).
 */
function fakeClient(queryError: { message: string } | null = null) {
  const calls: { eq: Array<[string, unknown]>; update: unknown } = { eq: [], update: undefined }
  const chain = {
    from: vi.fn(() => chain),
    update: vi.fn((payload: unknown) => {
      calls.update = payload
      return chain
    }),
    eq: vi.fn((col: string, val: unknown) => {
      calls.eq.push([col, val])
      return chain
    }),
    then: (resolve: (v: { error: { message: string } | null }) => void) =>
      resolve({ error: queryError }),
  }
  return { client: chain as unknown as SupabaseClient, calls }
}

describe('reconcileCheckpointsForPr — escopo exato (projeto + PR + só published)', () => {
  it('grava integration_status e push_status quando merged', async () => {
    const { client, calls } = fakeClient()
    await reconcileCheckpointsForPr(
      client,
      { projectId: 'proj-1', prNumber: 42 },
      { pushStatus: 'integrated', integrationStatus: 'merged' },
    )
    expect(calls.update).toEqual({ integration_status: 'merged', push_status: 'integrated' })
  })

  it('sem merge (pushStatus null) → NUNCA grava push_status, só integration_status', () => {
    const { client, calls } = fakeClient()
    void reconcileCheckpointsForPr(
      client,
      { projectId: 'proj-1', prNumber: 42 },
      { pushStatus: null, integrationStatus: 'ci_running' },
    )
    expect(calls.update).toEqual({ integration_status: 'ci_running' })
    expect(calls.update).not.toHaveProperty('push_status')
  })

  it('escopa a query por project_id + pr_number + push_status=published — nunca varre checkpoints de outro projeto/PR nem reabre um já resolvido', () => {
    const { client, calls } = fakeClient()
    void reconcileCheckpointsForPr(
      client,
      { projectId: 'proj-1', prNumber: 42 },
      { pushStatus: 'integrated', integrationStatus: 'merged' },
    )
    expect(calls.eq).toEqual([
      ['project_id', 'proj-1'],
      ['pr_number', 42],
      ['push_status', 'published'],
    ])
  })

  it('lança quando o Supabase reporta erro — nunca engole silenciosamente uma falha da query', async () => {
    // Bug real: a versão anterior não checava `error` — uma falha da query
    // (rede, permissão, o que for) virava sucesso silencioso. Se isto rodar
    // DEPOIS de o projeto já ter sido gravado como 'merged' (a ordem real no
    // webhook), o projeto vira READY e os checkpoints ficam presos sem
    // NENHUM sinal de erro. Agora precisa lançar, pro catch do webhook route
    // ao menos REGISTRAR a falha.
    const { client } = fakeClient({ message: 'connection reset' })
    await expect(
      reconcileCheckpointsForPr(
        client,
        { projectId: 'proj-1', prNumber: 42 },
        { pushStatus: 'integrated', integrationStatus: 'merged' },
      ),
    ).rejects.toThrow(/connection reset/)
  })
})

/**
 * v3-14: uma vez que push_status vira 'integrated', o PROJETO sai de
 * RECONCILABLE_STATES e a PR (fechada) some de getOpenPullRequestNumber —
 * nada no fallback voltava a visitar essa PR pra retentar um cleanup de
 * branch que falhou. `listPendingIntegrationBranchCleanups` é a query que
 * reabre essa porta, reaproveitando dados que reconcileCheckpointsForPr já
 * grava (nenhuma coluna nova).
 */
function fakeReadClient(rows: Array<Record<string, unknown>>, queryError: { message: string } | null = null) {
  const calls: { eq: Array<[string, unknown]>; not: Array<[string, unknown]>; order?: unknown; limit?: number } = {
    eq: [],
    not: [],
  }
  const chain = {
    from: vi.fn(() => chain),
    select: vi.fn(() => chain),
    eq: vi.fn((col: string, val: unknown) => {
      calls.eq.push([col, val])
      return chain
    }),
    not: vi.fn((col: string, op: string, val: unknown) => {
      calls.not.push([col, val])
      return chain
    }),
    order: vi.fn((col: string, opts: unknown) => {
      calls.order = { col, opts }
      return chain
    }),
    limit: vi.fn((n: number) => {
      calls.limit = n
      return chain
    }),
    then: (resolve: (v: { data: Array<Record<string, unknown>> | null; error: { message: string } | null }) => void) =>
      resolve({ data: queryError ? null : rows, error: queryError }),
  }
  return { client: chain as unknown as SupabaseClient, calls }
}

describe('listPendingIntegrationBranchCleanups — reabre a porta que RECONCILABLE_STATES/getOpenPullRequestNumber fecham (v3-14)', () => {
  it('filtra por integrated + merged + integration_branch/pr_number não-nulos', async () => {
    const { client, calls } = fakeReadClient([])
    await listPendingIntegrationBranchCleanups(client)
    expect(calls.eq).toEqual([
      ['push_status', 'integrated'],
      ['integration_status', 'merged'],
    ])
    expect(calls.not).toEqual([
      ['integration_branch', null],
      ['pr_number', null],
    ])
    expect(calls.limit).toBe(200) // default — mesmo teto de listProjectsForReconcile
  })

  it('respeita um limit customizado', async () => {
    const { client, calls } = fakeReadClient([])
    await listPendingIntegrationBranchCleanups(client, 5)
    expect(calls.limit).toBe(5)
  })

  it('mapeia project_id/pr_number/integration_branch das linhas', async () => {
    const { client } = fakeReadClient([
      {
        project_id: 'proj-1',
        pr_number: 42,
        integration_branch: 'supremo/cp-abc',
        created_at: '2026-01-02T00:00:00.000Z',
      },
    ])
    const out = await listPendingIntegrationBranchCleanups(client)
    expect(out).toEqual([{ projectId: 'proj-1', prNumber: 42, integrationBranch: 'supremo/cp-abc' }])
  })

  it('dedupe por (project_id, pr_number) — 2+ checkpoints da MESMA PR (reuse/synchronize, v3-8) geram só 1 candidato', async () => {
    const { client } = fakeReadClient([
      {
        project_id: 'proj-1',
        pr_number: 42,
        integration_branch: 'supremo/cp-final',
        created_at: '2026-01-02T00:05:00.000Z',
      },
      {
        project_id: 'proj-1',
        pr_number: 42,
        integration_branch: 'supremo/cp-final',
        created_at: '2026-01-02T00:00:00.000Z',
      },
    ])
    const out = await listPendingIntegrationBranchCleanups(client)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ projectId: 'proj-1', prNumber: 42, integrationBranch: 'supremo/cp-final' })
  })

  it('PRs diferentes (mesmo projeto ou não) → um candidato cada', async () => {
    const { client } = fakeReadClient([
      { project_id: 'proj-1', pr_number: 1, integration_branch: 'supremo/cp-a', created_at: 't1' },
      { project_id: 'proj-1', pr_number: 2, integration_branch: 'supremo/cp-b', created_at: 't2' },
      { project_id: 'proj-2', pr_number: 1, integration_branch: 'supremo/cp-c', created_at: 't3' },
    ])
    const out = await listPendingIntegrationBranchCleanups(client)
    expect(out).toHaveLength(3)
  })

  it('erro na query → [] fail-safe, nunca lança (é um sweep best-effort, não deve derrubar o fallback)', async () => {
    const { client } = fakeReadClient([], { message: 'connection reset' })
    await expect(listPendingIntegrationBranchCleanups(client)).resolves.toEqual([])
  })
})
