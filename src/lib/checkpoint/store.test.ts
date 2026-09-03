import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { reconcileCheckpointsForPr } from './store'

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
