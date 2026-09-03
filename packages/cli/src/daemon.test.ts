import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CheckpointRecord } from './checkpoint'
import type { CommitReader } from './changeset'
import type { RestoreDeps } from './restore'
import {
  AuthError,
  ConflictError,
  NetworkError,
  backoffDelayMs,
  classifyPidSignalError,
  daemonStatus,
  DAEMON_PID_FILE,
  ensureDaemon,
  processCheckpoint,
  processRestores,
  selectNextPending,
  type DaemonContext,
  type DaemonHttp,
  type PublishInput,
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

// Leitor fake com um binário, uma modificação, uma deleção e um rename.
const reader: CommitReader = {
  changes: () => [
    { status: 'M', path: 'app/page.tsx' },
    { status: 'A', path: 'public/logo.png' },
    { status: 'D', path: 'old.ts' },
    { status: 'R100', path: 'b.ts', oldPath: 'a.ts' },
  ],
  content: (_sha, path) => {
    if (path === 'old.ts') return null
    if (path === 'public/logo.png') return Buffer.from([0, 1, 2, 255, 254])
    return Buffer.from('conteúdo de ' + path, 'utf8')
  },
  meta: () => ({ message: 'checkpoint: home', authorName: 'Dev', authorEmail: 'd@e.co' }),
  executable: () => false,
}

function fakes(opts: { secret?: string | null; publishThrows?: unknown }) {
  const sent: PublishInput[] = []
  const http: DaemonHttp = {
    publish: async (input) => {
      sent.push(input)
      if (opts.publishThrows) throw opts.publishThrows
      return { prNumber: 42 }
    },
  }
  const ctx: DaemonContext = {
    projectId: 'proj-1',
    getSecret: () => (opts.secret === undefined ? 'sup_dev_ckpt_xyz' : opts.secret),
    http,
    reader,
  }
  return { ctx, sent }
}

describe('selectNextPending — ordem preservada (testes 3, 15)', () => {
  it('pega o primeiro retriável, pulando concluídos/terminais', () => {
    const q = [
      record({ checkpointId: 'a', pushStatus: 'published' }),
      record({ checkpointId: 'b', pushStatus: 'push_failed' }),
      record({ checkpointId: 'c', pushStatus: 'local' }),
      record({ checkpointId: 'd', pushStatus: 'upload_pending' }),
    ]
    expect(selectNextPending(q)?.checkpointId).toBe('c')
  })
})

describe('backoffDelayMs — retry (teste 10)', () => {
  it('cresce exponencialmente com teto', () => {
    expect(backoffDelayMs(0)).toBe(2000)
    expect(backoffDelayMs(2)).toBe(8000)
    expect(backoffDelayMs(100)).toBe(60000)
  })
})

describe('processCheckpoint — publica via changeset, SEM token nem git push', () => {
  it('device não provisionado → falha (não envia)', async () => {
    const { ctx, sent } = fakes({ secret: null })
    const out = await processCheckpoint(record(), ctx)
    expect(out.result).toBe('failed')
    expect(sent).toHaveLength(0)
  })

  it('sucesso → published + prNumber; envia changeset content-addressed', async () => {
    const { ctx, sent } = fakes({})
    const out = await processCheckpoint(record(), ctx)
    expect(out.result).toBe('done')
    expect(out.record.pushStatus).toBe('published')
    expect(out.record.prNumber).toBe(42)

    // O que foi enviado é um CHANGESET + hash — NUNCA um token.
    expect(sent).toHaveLength(1)
    const p = sent[0]!
    expect(p.deviceSecret).toBe('sup_dev_ckpt_xyz')
    expect(p.changesetSha256).toHaveLength(64)
    expect(JSON.stringify(p)).not.toMatch(/ghs_|ghp_|installation.*token|"token"/i)

    // binário preservado (byte 255) em base64
    const png = p.changeset.files.find((f) => f.path === 'public/logo.png')!
    expect(png.op).toBe('add')
    expect(Buffer.from(png.contentBase64!, 'base64')).toEqual(Buffer.from([0, 1, 2, 255, 254]))
    expect(png.sha256).toHaveLength(64)

    // rename vira delete(old) + add(new); deleção sem conteúdo
    expect(p.changeset.files.some((f) => f.path === 'a.ts' && f.op === 'delete')).toBe(true)
    expect(p.changeset.files.some((f) => f.path === 'b.ts' && f.op === 'add')).toBe(true)
    expect(p.changeset.files.some((f) => f.path === 'old.ts' && f.op === 'delete')).toBe(true)
  })

  it('offline → upload_pending, attempts++ (teste offline/seção 6)', async () => {
    const { ctx } = fakes({ publishThrows: new NetworkError('x') })
    const out = await processCheckpoint(record({ attempts: 1 }), ctx)
    expect(out.result).toBe('deferred')
    expect(out.record.pushStatus).toBe('upload_pending')
    expect(out.record.attempts).toBe(2)
  })

  it('409 conflito (corrida/non-ff) → upload_pending para re-tentar', async () => {
    const { ctx } = fakes({ publishThrows: new ConflictError('x') })
    const out = await processCheckpoint(record(), ctx)
    expect(out.result).toBe('deferred')
    expect(out.record.pushStatus).toBe('upload_pending')
  })

  it('device revogado (401/403) → push_failed', async () => {
    const { ctx } = fakes({ publishThrows: new AuthError('401') })
    const out = await processCheckpoint(record(), ctx)
    expect(out.result).toBe('failed')
    expect(out.record.pushStatus).toBe('push_failed')
  })
})

describe('daemon NUNCA fala com o GitHub nem manipula token (testes 1,13,19)', () => {
  const src = readFileSync(join(__dirname, 'daemon.ts'), 'utf8')
  it('nenhuma chamada à API do GitHub, credential helper ou token de git', () => {
    expect(src).not.toContain('api.github.com')
    expect(src).not.toContain('SUPREMO_GIT_TOKEN')
    expect(src).not.toContain('access_tokens')
    expect(src).not.toContain('credential.helper')
    expect(src).not.toContain('refs/heads')
    expect(src).not.toMatch(/Bearer/)
  })
  it('não faz push de git (só spawna a própria CLI, não o git)', () => {
    // o único spawn é do próprio binário node p/ rodar o loop detached
    expect(src).not.toMatch(/spawn\(\s*['"]git['"]/)
    expect(src).not.toMatch(/execFileSync\(\s*['"]git['"]/)
  })
  it('não faz polling de CI nem toca o preview', () => {
    expect(src).not.toContain('getChecks')
    expect(src).not.toContain('preview.pid')
    expect(src).not.toContain('preview:stop')
  })
  it('DaemonHttp expõe só publish (nenhum grant/token)', () => {
    expect(src).toContain('publish(input: PublishInput)')
    expect(src).not.toContain('requestGrant')
    expect(src).not.toContain('revokeToken')
  })
})

describe('processRestores — restore no próprio Supremo (v3.1 finalização)', () => {
  const cfg = { projectId: 'proj-1', apiBaseUrl: 'https://x', cwd: '/tmp/x' }

  function fakeHttp(opts: {
    pending?: Array<{ restoreRequestId: string; targetCheckpointId: string; targetSummary: string }>
    pollThrows?: boolean
  }): { http: DaemonHttp; applied: unknown[]; failed: unknown[] } {
    const applied: unknown[] = []
    const failed: unknown[] = []
    const http: DaemonHttp = {
      publish: async () => ({ prNumber: 0 }),
      pollRestores: async () => {
        if (opts.pollThrows) throw new NetworkError('offline')
        return opts.pending ?? []
      },
      reportRestoreApplied: async (input) => {
        applied.push(input)
      },
      reportRestoreFailed: async (input) => {
        failed.push(input)
      },
    }
    return { http, applied, failed }
  }

  it('sem device secret → não faz nada (0)', async () => {
    const { http } = fakeHttp({})
    const n = await processRestores({ ...cfg, getSecret: () => null }, { http })
    expect(n).toBe(0)
  })

  it('offline no poll → 0, sem lançar (o daemon continua vivo)', async () => {
    const { http } = fakeHttp({ pollThrows: true })
    const n = await processRestores({ ...cfg, getSecret: () => 'sup_dev_ckpt_x' }, { http })
    expect(n).toBe(0)
  })

  it('nada pendente → 0', async () => {
    const { http } = fakeHttp({ pending: [] })
    const n = await processRestores({ ...cfg, getSecret: () => 'sup_dev_ckpt_x' }, { http })
    expect(n).toBe(0)
  })

  it('aplica e reporta "applied" com o checkpoint E resultante', async () => {
    const { http, applied } = fakeHttp({
      pending: [{ restoreRequestId: 'req-1', targetCheckpointId: 'cpB', targetSummary: 'home minimalista' }],
    })
    const deps: RestoreDeps = {
      git: (args) => (args[0] === 'diff' ? 'diff --git a/x b/x\n@@' : args[0] === 'rev-parse' ? 'sha-E\n' : ''),
      readQueue: () => [
        {
          checkpointId: 'cpB',
          projectId: 'proj-1',
          commitSha: 'sha-B',
          parentCheckpointId: null,
          createdAt: 't',
          summary: 'home minimalista',
          riskLevel: 'low',
          migrations: [],
          changedPaths: [],
          pushStatus: 'published',
          attempts: 0,
        },
      ],
      appendQueue: () => {},
      notifyDaemon: () => {},
      now: () => 't',
      uuid: () => 'cpE',
      applyPatch: () => {},
      readWorktreeFile: () => null,
    }
    const n = await processRestores(
      { ...cfg, getSecret: () => 'sup_dev_ckpt_x' },
      { http, deps },
    )
    expect(n).toBe(1)
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ restoreRequestId: 'req-1', resultCheckpointId: 'cpE' })
  })

  it('alvo não encontrado localmente → reporta "failed", nunca trava o daemon', async () => {
    const { http, failed } = fakeHttp({
      pending: [{ restoreRequestId: 'req-2', targetCheckpointId: 'cp-inexistente', targetSummary: 'x' }],
    })
    const deps: RestoreDeps = {
      git: () => '',
      readQueue: () => [], // checkpoint não existe nesta máquina
      appendQueue: () => {},
      notifyDaemon: () => {},
      now: () => 't',
      uuid: () => 'cpE',
      applyPatch: () => {},
      readWorktreeFile: () => null,
    }
    const n = await processRestores(
      { ...cfg, getSecret: () => 'sup_dev_ckpt_x' },
      { http, deps },
    )
    expect(n).toBe(1)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ restoreRequestId: 'req-2' })
  })
})

describe('classifyPidSignalError — EPERM/indeterminado nunca vira "morto" (mesma classificação já validada no preview)', () => {
  it('ESRCH → dead (única prova real de que o processo não existe mais)', () => {
    expect(classifyPidSignalError('ESRCH')).toBe('dead')
  })

  it('EPERM → unknown (existe, só não é sinalizável DESTE contexto — NUNCA "dead")', () => {
    expect(classifyPidSignalError('EPERM')).toBe('unknown')
  })

  it('qualquer outro código, ou nenhum → unknown (nunca assume morto sem ESRCH)', () => {
    expect(classifyPidSignalError('EINVAL')).toBe('unknown')
    expect(classifyPidSignalError(undefined)).toBe('unknown')
    expect(classifyPidSignalError(null)).toBe('unknown')
  })
})

/**
 * BUG REAL (macOS/sandboxes): `ensureDaemon`/`daemonStatus` tratavam EPERM de
 * `process.kill(pid, 0)` como "morto" — um daemon vivo e saudável, só não
 * sinalizável a partir deste contexto, perdia o rastro e `ensureDaemon`
 * subia uma SEGUNDA instância por cima, duplicando quem envia checkpoints.
 *
 * Reproduz com um pid REAL e vivo (o processo desta suíte) — nunca um número
 * mágico — forçando só `process.kill(<esse pid>, 0)` a lançar EPERM de
 * verdade (`.code === 'EPERM'`, o mesmo formato que o Node lança quando o SO
 * nega o sinal). Restaura `process.kill` original sempre, mesmo em falha.
 */
describe('ensureDaemon/daemonStatus — EPERM nunca duplica um daemon vivo (macOS/sandboxes)', () => {
  function withEpermFor(pid: number, fn: () => void): void {
    const real = process.kill.bind(process)
    process.kill = ((target: number | string, signal?: string | number) => {
      if (Number(target) === pid && signal === 0) {
        const err = new Error('kill EPERM (test shim)') as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      return real(target as number, signal as never)
    }) as typeof process.kill
    try {
      fn()
    } finally {
      process.kill = real
    }
  }

  function tempDaemonDir(pid: number): string {
    const dir = mkdtempSync(join(tmpdir(), 'supremo-daemon-eperm-'))
    mkdirSync(join(dir, dirname(DAEMON_PID_FILE)), { recursive: true })
    writeFileSync(join(dir, DAEMON_PID_FILE), String(pid))
    return dir
  }

  it('daemonStatus: pid vivo mas EPERM → running/healthy true (nunca "morto" por engano)', () => {
    const dir = tempDaemonDir(process.pid)
    try {
      withEpermFor(process.pid, () => {
        const status = daemonStatus(dir)
        expect(status.running).toBe(true)
        expect(status.healthy).toBe(true)
        expect(status.pid).toBe(process.pid)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ensureDaemon: pid vivo mas EPERM → "reuse", NUNCA sobe uma segunda instância', () => {
    const dir = tempDaemonDir(process.pid)
    try {
      withEpermFor(process.pid, () => {
        expect(ensureDaemon(dir)).toBe('reuse')
      })
      // pidfile intacto — nunca sobrescrito com o pid de uma instância nova
      expect(readFileSync(join(dir, DAEMON_PID_FILE), 'utf8').trim()).toBe(String(process.pid))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('processo REALMENTE morto (ESRCH, não EPERM) continua reportado como morto — fail-safe não virou fail-open', () => {
    // pid de um processo que rodou e já terminou — garantidamente ESRCH,
    // nunca um número mágico que poderia colidir com algo vivo de verdade.
    // (o "start" real de ensureDaemon — que spawna um novo processo por cima
    // de um pid morto — já é coberto E2E em lifecycle-smoke.test.ts, com o
    // binário empacotado de verdade; aqui o alvo é só a classificação.)
    const exited = spawnSync(process.execPath, ['-e', '1'])
    const deadPid = exited.pid!
    const dir = tempDaemonDir(deadPid)
    try {
      const status = daemonStatus(dir)
      expect(status.running).toBe(false)
      expect(status.healthy).toBe(false)
      expect(status.pid).toBe(deadPid) // o pidfile em si é só lido, não "limpo"
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
