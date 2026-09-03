import { describe, expect, it } from 'vitest'
import type { CheckpointRecord } from './checkpoint'
import {
  planSync,
  resolveParentCheckpointId,
  runSync,
  type RemoteCheckpointInfo,
  type SyncDeps,
  type SyncedRemoteState,
} from './sync'

/** Registro mínimo válido de fila (mesmo padrão de restore.test.ts). */
const queueRecord = (checkpointId: string, createdAt: string): CheckpointRecord => ({
  checkpointId,
  projectId: 'proj-1',
  commitSha: `sha-${checkpointId}`,
  parentCheckpointId: null,
  createdAt,
  summary: checkpointId,
  riskLevel: 'low',
  migrations: [],
  changedPaths: [],
  pushStatus: 'integrated',
  attempts: 0,
})

// ── Puro ─────────────────────────────────────────────────────────────────────

describe('resolveParentCheckpointId — a base do PRÓXIMO checkpoint (v3.3)', () => {
  it('nada local, nada sincronizado → null', () => {
    expect(resolveParentCheckpointId([], null)).toBeNull()
  })

  it('só fila local (nunca sincronizou) → o último da fila', () => {
    const queue = [
      { checkpointId: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
      { checkpointId: 'b', createdAt: '2026-01-02T00:00:00.000Z' },
    ]
    expect(resolveParentCheckpointId(queue, null)).toBe('b')
  })

  it('fila vazia, só sincronizado (máquina nova/fresh clone) → o sincronizado', () => {
    const synced: SyncedRemoteState = {
      checkpointId: 'c',
      createdAt: '2026-01-03T00:00:00.000Z',
      checkedAt: '2026-01-04T00:00:00.000Z',
    }
    expect(resolveParentCheckpointId([], synced)).toBe('c')
  })

  it('sincronizado é MAIS NOVO que o último local (máquina que ficou pra trás) → o sincronizado vence', () => {
    const queue = [{ checkpointId: 'old-local', createdAt: '2026-01-01T00:00:00.000Z' }]
    const synced: SyncedRemoteState = {
      checkpointId: 'newer-remote',
      createdAt: '2026-01-05T00:00:00.000Z',
      checkedAt: '2026-01-05T00:00:01.000Z',
    }
    expect(resolveParentCheckpointId(queue, synced)).toBe('newer-remote')
  })

  it('checkpoint local criado DEPOIS do último sync (segundo checkpoint da sessão) → o local vence', () => {
    const synced: SyncedRemoteState = {
      checkpointId: 'synced-earlier',
      createdAt: '2026-01-01T00:00:00.000Z',
      checkedAt: '2026-01-01T00:00:01.000Z',
    }
    const queue = [{ checkpointId: 'new-local', createdAt: '2026-01-02T00:00:00.000Z' }]
    expect(resolveParentCheckpointId(queue, synced)).toBe('new-local')
  })
})

const remote = (over: Partial<RemoteCheckpointInfo> = {}): RemoteCheckpointInfo => ({
  id: 'cp-remote',
  createdAt: '2026-01-05T00:00:00.000Z',
  summary: 'algo publicado noutra máquina',
  pushStatus: 'integrated',
  integrationStatus: 'merged',
  integrationBranch: null,
  publishedSha: null,
  ...over,
})

describe('planSync — decisão pura (item 4: continuidade entre máquinas nunca espera o CI)', () => {
  it('remoto inalcançável → unreachable, mesmo que tudo mais indique atraso', () => {
    const action = planSync({
      localCheckpointId: 'old',
      remote: remote(),
      worktreeClean: true,
      remoteReachable: false,
    })
    expect(action.kind).toBe('unreachable')
  })

  it('remoto null (projeto sem nenhum checkpoint ainda) → up_to_date', () => {
    const action = planSync({
      localCheckpointId: null,
      remote: null,
      worktreeClean: true,
      remoteReachable: true,
    })
    expect(action.kind).toBe('up_to_date')
  })

  it('local == remoto → up_to_date (item 1: nenhuma sincronização desnecessária)', () => {
    const action = planSync({
      localCheckpointId: 'cp-remote',
      remote: remote({ id: 'cp-remote' }),
      worktreeClean: true,
      remoteReachable: true,
    })
    expect(action.kind).toBe('up_to_date')
  })

  it('atrás + worktree LIMPO + já INTEGRADO (mergeado) → fast_forward pra `main`, sem pin (item 2)', () => {
    const target = remote({ pushStatus: 'integrated', integrationStatus: 'ci_running' })
    const action = planSync({
      localCheckpointId: 'old',
      remote: target,
      worktreeClean: true,
      remoteReachable: true,
    })
    // `main` só avança por merge protegido/CI-gated — segue o tip real, sem
    // precisar pinar em nenhum SHA específico (ver `syncTarget`).
    expect(action).toEqual({ kind: 'fast_forward', target, branch: 'main', pinnedSha: null })
  })

  it('atrás + worktree SUJO → diverged_dirty, NUNCA fast_forward (item 3: nada é sobrescrito)', () => {
    const action = planSync({
      localCheckpointId: 'old',
      remote: remote(),
      worktreeClean: false,
      remoteReachable: true,
    })
    expect(action.kind).toBe('diverged_dirty')
  })

  /**
   * Pedido explícito (ajuste): a continuidade de edição entre máquinas NUNCA
   * depende do checkpoint já estar integrado em `main`. Mac em A→B→C, C
   * PUBLICADO mas CI ainda rodando; notebook parado em A tem que conseguir
   * sincronizar com C — usando a `integration_branch` REAL já gerenciada
   * pelo Supremo (nunca estado arbitrário), sem esperar o CI de C terminar.
   */
  it('atrás + limpo + PUBLICADO (branch real existe) mas AINDA EM CI (não mergeado) → fast_forward pra integration_branch, pinado no published_sha exato', () => {
    const target = remote({
      pushStatus: 'published',
      integrationStatus: 'ci_running',
      integrationBranch: 'supremo/cp-c',
      publishedSha: 'sha-c-published',
    })
    const action = planSync({
      localCheckpointId: 'old',
      remote: target,
      worktreeClean: true,
      remoteReachable: true,
    })
    expect(action).toEqual({
      kind: 'fast_forward',
      target,
      branch: 'supremo/cp-c',
      pinnedSha: 'sha-c-published',
    })
  })

  /**
   * REGRESSÃO ESPECÍFICA do ajuste (item 2 — race de `integration_branch`):
   * a branch pode ganhar um checkpoint NOVO de outra máquina entre a
   * consulta ao sync-status e o `git fetch` deste comando (a branch continua
   * ABERTA, PR/CI em andamento). O `pinnedSha` — não a branch em si — é o
   * que garante que o fast-forward pousa EXATAMENTE no checkpoint consultado,
   * nunca em "o que quer que esteja lá agora".
   */
  it('"published" mas SEM published_sha (inconsistência defensiva) → ahead_publishing, NUNCA pina em nada incerto', () => {
    const action = planSync({
      localCheckpointId: 'old',
      remote: remote({
        pushStatus: 'published',
        integrationStatus: 'ci_running',
        integrationBranch: 'supremo/cp-c',
        publishedSha: null,
      }),
      worktreeClean: true,
      remoteReachable: true,
    })
    expect(action.kind).toBe('ahead_publishing')
  })

  it('atrás + limpo + ainda "publishing" (nenhuma branch confirmada ainda) → ahead_publishing, nunca puxa estado não publicado', () => {
    const action = planSync({
      localCheckpointId: 'old',
      remote: remote({ pushStatus: 'publishing', integrationStatus: null, integrationBranch: null }),
      worktreeClean: true,
      remoteReachable: true,
    })
    expect(action.kind).toBe('ahead_publishing')
  })

  it('atrás + limpo + "failed" (nunca chegou a publicar de verdade) → ahead_publishing, nunca um estado arbitrário', () => {
    const action = planSync({
      localCheckpointId: 'old',
      remote: remote({ pushStatus: 'failed', integrationStatus: null, integrationBranch: null }),
      worktreeClean: true,
      remoteReachable: true,
    })
    expect(action.kind).toBe('ahead_publishing')
  })

  it('"published" mas SEM integration_branch (inconsistência defensiva) → ahead_publishing, fail-closed', () => {
    const action = planSync({
      localCheckpointId: 'old',
      remote: remote({ pushStatus: 'published', integrationStatus: 'ci_running', integrationBranch: null }),
      worktreeClean: true,
      remoteReachable: true,
    })
    expect(action.kind).toBe('ahead_publishing')
  })

  it('mergeado via integration_status="merged" mesmo com push_status ainda "published" → fast_forward pra `main`', () => {
    const action = planSync({
      localCheckpointId: 'old',
      remote: remote({ pushStatus: 'published', integrationStatus: 'merged', integrationBranch: 'supremo/cp-x' }),
      worktreeClean: true,
      remoteReachable: true,
    })
    expect(action).toMatchObject({ kind: 'fast_forward', branch: 'main' })
  })
})

// ── Fakes injetáveis (orquestração — mesmo padrão de restore.test.ts) ────────

function fakeDeps(opts: {
  queue?: CheckpointRecord[]
  synced?: SyncedRemoteState | null
  porcelain?: string
  fetchResult: Awaited<ReturnType<SyncDeps['fetchRemote']>>
  gitShouldFail?: 'fetch' | 'merge'
}): { deps: SyncDeps; calls: string[][]; written: SyncedRemoteState[] } {
  const calls: string[][] = []
  const written: SyncedRemoteState[] = []
  const deps: SyncDeps = {
    git: (args) => {
      calls.push(args)
      if (args[0] === 'status') return opts.porcelain ?? ''
      if (args[0] === 'fetch' && opts.gitShouldFail === 'fetch') throw new Error('fetch failed')
      if (args[0] === 'merge' && opts.gitShouldFail === 'merge') throw new Error('not a fast-forward')
      return ''
    },
    readQueue: () => opts.queue ?? [],
    readSyncedRemote: () => opts.synced ?? null,
    writeSyncedRemote: (state) => written.push(state),
    fetchRemote: () => Promise.resolve(opts.fetchResult),
  }
  return { deps, calls, written }
}

describe('runSync — orquestração (item 8: nunca reset/force; item 6 é coberto na regra do agente)', () => {
  it('local == remoto → nenhuma chamada de fetch/merge (item 1)', async () => {
    const { deps, calls } = fakeDeps({
      queue: [queueRecord('cp-remote', '2026-01-05T00:00:00.000Z')],
      porcelain: '',
      fetchResult: { ok: true, latest: remote({ id: 'cp-remote' }) },
    })
    const outcome = await runSync(deps)
    expect(outcome.action.kind).toBe('up_to_date')
    expect(calls.some((c) => c[0] === 'fetch' || c[0] === 'merge')).toBe(false)
  })

  it('atrás + worktree limpo + mergeado → git fetch + merge --ff-only (NUNCA --force/reset) — item 2', async () => {
    const { deps, calls, written } = fakeDeps({
      queue: [queueRecord('old', '2026-01-01T00:00:00.000Z')],
      porcelain: '',
      fetchResult: { ok: true, latest: remote() },
    })
    const outcome = await runSync(deps)
    expect(outcome.action.kind).toBe('fast_forward')
    expect(calls).toContainEqual(['fetch', 'origin', 'main'])
    expect(calls).toContainEqual(['merge', '--ff-only', 'origin/main'])
    // NUNCA --force, nunca reset — em nenhuma chamada de git desta suíte.
    expect(calls.flat()).not.toContain('--force')
    expect(calls.flat()).not.toContain('reset')
    expect(calls.flat()).not.toContain('-f')
    expect(written).toEqual([
      { checkpointId: remote().id, createdAt: remote().createdAt, checkedAt: expect.any(String) },
    ])
  })

  it('atrás + worktree SUJO → NENHUM git fetch/merge, trabalho local preservado (item 3)', async () => {
    const { deps, calls, written } = fakeDeps({
      queue: [queueRecord('old', '2026-01-01T00:00:00.000Z')],
      porcelain: ' M app/dirty.ts\n',
      fetchResult: { ok: true, latest: remote() },
    })
    const outcome = await runSync(deps)
    expect(outcome.action.kind).toBe('diverged_dirty')
    expect(calls.some((c) => c[0] === 'fetch' || c[0] === 'merge')).toBe(false)
    expect(written).toHaveLength(0) // não reescreve a base "confirmada" sem ter sincronizado de fato
    expect(outcome.message).toMatch(/alterações não salvas|nada foi sobrescrito/)
  })

  /**
   * REGRESSÃO ESPECÍFICA do ajuste pedido: "Mac está em A→B→C, checkpoint C
   * já foi publicado, mas CI ainda está rodando. Abro o notebook parado em
   * A. Ele deve conseguir sincronizar com C e continuar C→D, sem esperar o
   * CI de C terminar." — máquina nova (fila vazia) sincroniza pra C via a
   * `integration_branch` REAL (nunca `main` — C ainda não mergeou) e o
   * PRÓXIMO checkpoint (D) já nasce com parentCheckpointId = C.
   */
  it('A local + C publicado mas ainda em CI → máquina nova sincroniza pra C (integration_branch, NUNCA main) e D nasce baseado em C', async () => {
    const checkpointC = remote({
      id: 'cp-c',
      createdAt: '2026-01-03T00:00:00.000Z',
      summary: 'checkpoint C',
      pushStatus: 'published', // publicado com sucesso — branch real existe
      integrationStatus: 'ci_running', // CI ainda rodando — NÃO mergeado
      integrationBranch: 'supremo/cp-c',
      publishedSha: 'sha-c-published',
    })
    const { deps, calls, written } = fakeDeps({
      queue: [queueRecord('cp-a', '2026-01-01T00:00:00.000Z')], // notebook parado em A
      synced: null,
      porcelain: '',
      fetchResult: { ok: true, latest: checkpointC },
    })
    const outcome = await runSync(deps)

    expect(outcome.action.kind).toBe('fast_forward')
    // Sincroniza pela branch REAL já gerenciada pelo Supremo — nunca `main`
    // (C ainda não integrou) e nunca um estado arbitrário/não publicado.
    // O MERGE pina no SHA exato de C (`published_sha`), NUNCA no tip móvel
    // `origin/supremo/cp-c` — ver o teste de race dedicado logo abaixo.
    expect(calls).toContainEqual(['fetch', 'origin', 'supremo/cp-c'])
    expect(calls).toContainEqual(['merge', '--ff-only', 'sha-c-published'])
    expect(calls.flat()).not.toContain('origin/supremo/cp-c')
    expect(calls.flat()).not.toContain('main')
    expect(calls.flat()).not.toContain('origin/main')
    expect(written).toEqual([
      { checkpointId: 'cp-c', createdAt: checkpointC.createdAt, checkedAt: expect.any(String) },
    ])

    // D (o próximo checkpoint) nasce baseado em C — nunca em A (o notebook
    // não fica "preso" ao estado antigo depois de sincronizar).
    const nextParent = resolveParentCheckpointId(
      [queueRecord('cp-a', '2026-01-01T00:00:00.000Z')],
      written[0]!,
    )
    expect(nextParent).toBe('cp-c')
  })

  /**
   * REGRESSÃO ESPECÍFICA (item 2 do ajuste) — race real da sincronização por
   * `integration_branch`: sync-status informou o checkpoint C; ENQUANTO a
   * máquina B sincroniza, a máquina A publica D na MESMA integration_branch
   * (ela continua aberta, PR/CI em andamento). B nunca pode terminar com
   * HEAD em D mas gravar C como base — `runSync` NUNCA usa `origin/<branch>`
   * como alvo do merge quando um `publishedSha` está disponível; o alvo é
   * sempre o SHA exato do checkpoint que o sync-status realmente informou,
   * imune a qualquer avanço da branch nesse meio-tempo (o E2E com git de
   * verdade em sync-e2e.test.ts prova isto ponta a ponta).
   */
  it('branch de integração pode avançar (outra máquina publica D nela) enquanto sincroniza — merge NUNCA usa o tip móvel da branch, só o published_sha exato', async () => {
    const checkpointC = remote({
      id: 'cp-c',
      pushStatus: 'published',
      integrationStatus: 'ci_running',
      integrationBranch: 'supremo/cp-c', // MESMA branch onde D seria publicado depois
      publishedSha: 'sha-c-exato',
    })
    const { deps, calls, written } = fakeDeps({
      queue: [],
      synced: null,
      porcelain: '',
      fetchResult: { ok: true, latest: checkpointC },
    })
    await runSync(deps)

    const mergeCall = calls.find((c) => c[0] === 'merge')
    expect(mergeCall).toEqual(['merge', '--ff-only', 'sha-c-exato'])
    // Nunca um ref simbólico/móvel — mesmo que a branch já tenha avançado
    // pra D no remoto no instante do fetch, o merge só pode pousar em C.
    expect(mergeCall).not.toContain('origin/supremo/cp-c')
    expect(written[0]?.checkpointId).toBe('cp-c') // o estado gravado corresponde EXATAMENTE ao SHA pousado
  })

  it('ainda "publishing" (nenhuma branch confirmada) → nenhum fetch/merge, só reconhece que existe algo mais novo', async () => {
    const { deps, calls, written } = fakeDeps({
      queue: [queueRecord('old', '2026-01-01T00:00:00.000Z')],
      porcelain: '',
      fetchResult: {
        ok: true,
        latest: remote({ pushStatus: 'publishing', integrationStatus: null, integrationBranch: null }),
      },
    })
    const outcome = await runSync(deps)
    expect(outcome.action.kind).toBe('ahead_publishing')
    expect(calls.some((c) => c[0] === 'fetch' || c[0] === 'merge')).toBe(false)
    expect(written).toHaveLength(0)
  })

  it('remoto inalcançável (timeout/rede) → nunca trava, segue local, nenhum git tocado (item 7)', async () => {
    const { deps, calls } = fakeDeps({
      queue: [queueRecord('old', '2026-01-01T00:00:00.000Z')],
      porcelain: '',
      fetchResult: { ok: false },
    })
    const outcome = await runSync(deps)
    expect(outcome.action.kind).toBe('unreachable')
    expect(calls.some((c) => c[0] === 'fetch' || c[0] === 'merge')).toBe(false)
  })

  it('fast-forward não disponível (git merge falha) → nunca força, reporta e segue sem alterar nada', async () => {
    const { deps, written } = fakeDeps({
      queue: [queueRecord('old', '2026-01-01T00:00:00.000Z')],
      porcelain: '',
      fetchResult: { ok: true, latest: remote() },
      gitShouldFail: 'merge',
    })
    const outcome = await runSync(deps)
    expect(outcome.action.kind).toBe('fast_forward') // a DECISÃO foi tentar; a EXECUÇÃO que falhou
    expect(outcome.message).toMatch(/não foi possível sincronizar/)
    expect(written).toHaveLength(0) // nunca grava um estado que não foi de fato alcançado
  })
})
