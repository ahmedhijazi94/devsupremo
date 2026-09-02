import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CheckpointRecord } from './checkpoint'
import {
  AuthError,
  NetworkError,
  assertNotMain,
  backoffDelayMs,
  gitCredentialHelper,
  gitPushArgs,
  processCheckpoint,
  selectNextPending,
  type DaemonContext,
  type DaemonGit,
  type DaemonHttp,
  type GrantResponse,
  type IntegrationPlan,
} from './daemon'

const record = (over: Partial<CheckpointRecord> = {}): CheckpointRecord => ({
  checkpointId: 'cp1',
  projectId: 'proj-1',
  commitSha: 'sha-B',
  parentCheckpointId: null,
  createdAt: 't',
  summary: 'home minimalista',
  riskLevel: 'low',
  migrations: [],
  changedPaths: ['app/page.tsx'],
  pushStatus: 'local',
  attempts: 0,
  ...over,
})

// ── Fakes injetáveis ─────────────────────────────────────────────────────────

function fakes(opts: {
  plan: IntegrationPlan
  secret?: string | null
  grantThrows?: unknown
  ensureThrows?: unknown
  fetchMainSha?: string
}) {
  const events: string[] = []
  const http: DaemonHttp = {
    requestGrant: async (): Promise<GrantResponse> => {
      events.push('grant')
      if (opts.grantThrows) throw opts.grantThrows
      return { token: 'ghs_scoped', repoFullName: 'Hijaziia/app', plan: opts.plan }
    },
    ensurePr: async () => {
      events.push('ensurePr')
      if (opts.ensureThrows) throw opts.ensureThrows
      return { prNumber: 42 }
    },
    revokeToken: async (t) => {
      events.push(`revoke:${t}`)
    },
  }
  const git: DaemonGit = {
    fetchMainSha: () => {
      events.push('fetchMainSha')
      return opts.fetchMainSha ?? 'main-1'
    },
    pushReuse: (_r, sha, branch) => {
      events.push(`pushReuse:${sha}:${branch}`)
    },
    pushRotate: (_r, plan) => {
      events.push(`pushRotate:${plan.branch}:${plan.fromSha}..${plan.toSha}`)
    },
  }
  const ctx: DaemonContext = {
    projectId: 'proj-1',
    getSecret: () => (opts.secret === undefined ? 'sup_dev_ckpt_xyz' : opts.secret),
    http,
    git,
  }
  return { ctx, events }
}

const reusePlan: IntegrationPlan = {
  action: 'reuse',
  branch: 'supremo/cp-aaaa',
  base: 'main',
  expectedBaseSha: 'main-1',
  pushSha: 'sha-B',
}
const rotatePlan: IntegrationPlan = {
  action: 'rotate',
  branch: 'supremo/cp-bbbb',
  base: 'main',
  expectedBaseSha: 'main-2',
  deltaRange: { fromSha: 'sha-A', toSha: 'sha-B' },
}

// ── Puro ─────────────────────────────────────────────────────────────────────

describe('selectNextPending — ordem preservada (testes 3, 15)', () => {
  it('pega o primeiro retriável, pulando concluídos/terminais', () => {
    const q = [
      record({ checkpointId: 'a', pushStatus: 'pushed' }),
      record({ checkpointId: 'b', pushStatus: 'push_failed' }),
      record({ checkpointId: 'c', pushStatus: 'local' }),
      record({ checkpointId: 'd', pushStatus: 'local' }),
    ]
    expect(selectNextPending(q)?.checkpointId).toBe('c')
  })
  it('nada retriável → null', () => {
    expect(selectNextPending([record({ pushStatus: 'integrated' })])).toBeNull()
  })
})

describe('backoffDelayMs — retry (teste 10)', () => {
  it('cresce exponencialmente com teto', () => {
    expect(backoffDelayMs(0)).toBe(2000)
    expect(backoffDelayMs(1)).toBe(4000)
    expect(backoffDelayMs(2)).toBe(8000)
    expect(backoffDelayMs(100)).toBe(60000)
  })
})

describe('gitPushArgs — token nunca em argv/config/url (testes 5, 8, 18)', () => {
  it('push por refspec, URL LIMPA, sem token', () => {
    const args = gitPushArgs('Hijaziia/app', 'sha-B', 'supremo/cp-aaaa')
    expect(args).toContain('push')
    expect(args).toContain('https://github.com/Hijaziia/app.git')
    expect(args).toContain('sha-B:refs/heads/supremo/cp-aaaa')
    // nenhum token em lugar nenhum do comando
    expect(JSON.stringify(args)).not.toMatch(/ghs_|ghp_|x-access-token:|token=/)
    // o helper lê o token da ENV, não do comando
    expect(gitCredentialHelper()).toContain('$SUPREMO_GIT_TOKEN')
    expect(JSON.stringify(args)).not.toContain('ghs_scoped')
  })
  it('recusa push na main/master (teste 18)', () => {
    expect(() => gitPushArgs('Hijaziia/app', 'sha', 'main')).toThrow()
    expect(() => assertNotMain('main')).toThrow()
  })
})

// ── processCheckpoint ────────────────────────────────────────────────────────

describe('processCheckpoint', () => {
  it('device não provisionado → falha (não empurra)', async () => {
    const { ctx, events } = fakes({ plan: reusePlan, secret: null })
    const out = await processCheckpoint(record(), ctx)
    expect(out.result).toBe('failed')
    expect(events).toEqual([])
  })

  it('offline no grant → push_pending, attempts++ (teste 9)', async () => {
    const { ctx } = fakes({ plan: reusePlan, grantThrows: new NetworkError('x') })
    const out = await processCheckpoint(record({ attempts: 1 }), ctx)
    expect(out.result).toBe('deferred')
    expect(out.record.pushStatus).toBe('push_pending')
    expect(out.record.attempts).toBe(2)
  })

  it('device revogado (401/403) no grant → push_failed (teste 4)', async () => {
    const { ctx } = fakes({ plan: reusePlan, grantThrows: new AuthError('401') })
    const out = await processCheckpoint(record(), ctx)
    expect(out.result).toBe('failed')
    expect(out.record.pushStatus).toBe('push_failed')
  })

  it('reuse OK → push, revoga token, garante PR, NÃO espera CI (testes 11, 12, 13)', async () => {
    const { ctx, events } = fakes({ plan: reusePlan })
    const out = await processCheckpoint(record(), ctx)
    expect(out.result).toBe('done')
    expect(out.record.pushStatus).toBe('pushed')
    expect(out.record.prNumber).toBe(42)
    expect(out.record.integrationBranch).toBe('supremo/cp-aaaa')
    // ordem: grant → pushReuse → revoke → ensurePr (revoga ANTES de terminar)
    expect(events).toEqual([
      'grant',
      'pushReuse:sha-B:supremo/cp-aaaa',
      'revoke:ghs_scoped',
      'ensurePr',
    ])
  })

  it('rotate com base STALE → adia, revoga token, NÃO empurra (teste 17)', async () => {
    const { ctx, events } = fakes({ plan: rotatePlan, fetchMainSha: 'main-9' })
    const out = await processCheckpoint(record(), ctx)
    expect(out.result).toBe('deferred')
    expect(out.record.pushStatus).toBe('push_pending')
    expect(events).toContain('fetchMainSha')
    expect(events).toContain('revoke:ghs_scoped')
    expect(events.some((e) => e.startsWith('pushRotate'))).toBe(false)
  })

  it('rotate fresco → integra só o delta e não perde B (teste 16, execução)', async () => {
    const { ctx, events } = fakes({ plan: rotatePlan, fetchMainSha: 'main-2' })
    const out = await processCheckpoint(record(), ctx)
    expect(out.result).toBe('done')
    expect(events).toContain('pushRotate:supremo/cp-bbbb:sha-A..sha-B')
  })

  it('ensurePr offline após push → mantém pushing (retry idempotente)', async () => {
    const { ctx } = fakes({ plan: reusePlan, ensureThrows: new NetworkError('x') })
    const out = await processCheckpoint(record(), ctx)
    expect(out.result).toBe('deferred')
    expect(out.record.pushStatus).toBe('pushing')
  })
})

describe('daemon não espera CI nem toca o preview (testes 13, 19)', () => {
  it('o código do daemon não faz polling de CI nem mata o preview', () => {
    const src = readFileSync(join(__dirname, 'daemon.ts'), 'utf8')
    expect(src).not.toContain('getChecks')
    expect(src).not.toContain('wait_for_checks')
    expect(src).not.toContain('preview.pid')
    expect(src).not.toContain('preview:stop')
  })
})
