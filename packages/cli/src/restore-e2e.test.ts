import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildCheckpointRecord,
  parseQueue,
  serializeQueue,
  QUEUE_FILE,
  type CheckpointRecord,
} from './checkpoint'
import { applyRestore, defaultRestoreDeps, restoreCommitMessage } from './restore'
import { defaultCheckpointDeps } from './checkpoint'
import { processCheckpoint, type DaemonContext, type DaemonHttp } from './daemon'
import { defaultCommitReader } from './changeset'

/**
 * Regressão E2E (repositório git DE VERDADE, não fakes): restore request →
 * patch aplicado → NOVO checkpoint criado → publicação normal — a sequência
 * exata que o E2E real quebrou.
 *
 * Reproduz o bug com um hook `pre-commit` que SEMPRE falha (a mesma classe
 * de limitação ambiental/sandbox do E2E real — porta ocupada, rede
 * indisponível — sem depender de reproduzir o sandbox de verdade) instalado
 * ANTES do restore rodar, via `core.hooksPath` apontando pra fora do
 * worktree (não polui `git status` com o próprio arquivo do hook). Confirma
 * que `applyRestore` — usando os adapters REAIS, não fakes — ainda assim
 * completa o commit e o restore flui até a publicação normal.
 */
describe('restore — E2E real: patch aplicado → checkpoint E criado → publicado, mesmo com hook local bloqueando', () => {
  let dir: string
  let hooksDir: string

  afterEach(() => {
    for (const d of [dir, hooksDir]) {
      if (d) fs.rmSync(d, { recursive: true, force: true })
    }
  })

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }

  function queueRow(over: Partial<CheckpointRecord>): CheckpointRecord {
    return buildCheckpointRecord({
      checkpointId: 'placeholder',
      projectId: 'proj-1',
      commitSha: 'placeholder',
      parentCheckpointId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      summary: 'placeholder',
      changedPaths: ['app.txt'],
      ...over,
    }) as CheckpointRecord
  }

  it(
    'sequência completa: restore aplica o patch, cria o checkpoint E apesar do hook local travando, e ele publica normalmente',
    async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-restore-e2e-'))
      git(['init', '-q'], dir)
      git(['config', 'user.email', 'e2e@supremo.test'], dir)
      git(['config', 'user.name', 'Supremo E2E'], dir)
      // .supremo/checkpoints/ é gitignored no scaffold real (project-files.ts)
      // — sem isso aqui, a fila apareceria como untracked em `git status` e
      // dispararia a salvaguarda automática à toa, o que não reflete produção.
      fs.writeFileSync(path.join(dir, '.gitignore'), '.supremo/checkpoints/\n')
      git(['add', '-A'], dir)
      git(['commit', '-q', '-m', 'chore: gitignore'], dir)

      // checkpoint A (base)
      fs.writeFileSync(path.join(dir, 'app.txt'), 'estado A\n')
      git(['add', '-A'], dir)
      git(['commit', '-q', '-m', 'checkpoint: A'], dir)
      const shaA = git(['rev-parse', 'HEAD'], dir).trim()

      // checkpoint B — o ALVO do restore
      fs.writeFileSync(path.join(dir, 'app.txt'), 'estado B\n')
      git(['add', '-A'], dir)
      git(['commit', '-q', '-m', 'checkpoint: B'], dir)
      const shaB = git(['rev-parse', 'HEAD'], dir).trim()

      // checkpoint C — HEAD atual, o que o usuário quer desfazer
      fs.writeFileSync(path.join(dir, 'app.txt'), 'estado C (quebrado)\n')
      git(['add', '-A'], dir)
      git(['commit', '-q', '-m', 'checkpoint: C'], dir)
      const shaC = git(['rev-parse', 'HEAD'], dir).trim()

      // Fila local com A/B/C (o daemon lê daqui pra achar o SHA do alvo).
      // pushStatus real de A/B/C não importa pra este teste (findLocalCommit-
      // ForCheckpoint só olha checkpointId/commitSha) — buildCheckpointRecord
      // sempre nasce 'local'; os 3 já estarem "integrados" de verdade é
      // irrelevante pro que este teste prova (a criação do checkpoint E).
      const queue: CheckpointRecord[] = [
        queueRow({ checkpointId: 'cpA', commitSha: shaA, summary: 'A' }),
        queueRow({
          checkpointId: 'cpB',
          commitSha: shaB,
          parentCheckpointId: 'cpA',
          summary: 'B',
        }),
        queueRow({
          checkpointId: 'cpC',
          commitSha: shaC,
          parentCheckpointId: 'cpB',
          summary: 'C',
        }),
      ]
      const queuePath = path.join(dir, QUEUE_FILE)
      fs.mkdirSync(path.dirname(queuePath), { recursive: true })
      fs.writeFileSync(queuePath, serializeQueue(queue))

      // Instala um hook pre-commit que SEMPRE falha — reproduz a limitação
      // ambiental/sandbox do E2E real sem depender do sandbox de verdade.
      // core.hooksPath aponta pra FORA do worktree (o arquivo do hook não
      // aparece em `git status` do repo sob teste).
      hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-restore-hooks-'))
      fs.writeFileSync(
        path.join(hooksDir, 'pre-commit'),
        '#!/bin/sh\necho "build falhou: limitacao ambiental do sandbox (simulada)" >&2\nexit 1\n',
        { mode: 0o755 },
      )
      git(['config', 'core.hooksPath', hooksDir], dir)

      // Confirma que o hook REALMENTE bloqueia um commit comum — sem isso o
      // teste não prova que reproduz o bug. `add`/`reset` NARROW (só
      // outro.txt, nunca -A/--hard): a fila em .supremo/ (untracked, escrita
      // acima) não pode ser tocada por esta checagem.
      fs.writeFileSync(path.join(dir, 'outro.txt'), 'x\n')
      git(['add', 'outro.txt'], dir)
      expect(() => git(['commit', '-m', 'nao deveria passar'], dir)).toThrow()
      git(['reset', '-q', 'outro.txt'], dir)
      fs.rmSync(path.join(dir, 'outro.txt'))

      // O RESTORE de verdade: adapters REAIS (não fakes), mesmo caminho do daemon.
      const restoreDeps = defaultRestoreDeps(defaultCheckpointDeps(dir), dir)
      const outcome = applyRestore('cpB', 'B', 'proj-1', restoreDeps)

      expect(outcome.applied).toBe(true)
      expect(outcome.record).not.toBeNull()

      // git status limpo — nunca fica com a mudança pendente pra sempre
      // (era EXATAMENTE isto que o E2E real reportou: "M app.txt" travado).
      expect(git(['status', '--porcelain'], dir).trim()).toBe('')

      // Conteúdo igual a B, num commit NOVO (não um "voltar" destrutivo pro B antigo).
      expect(fs.readFileSync(path.join(dir, 'app.txt'), 'utf8')).toBe('estado B\n')
      const headAfter = git(['rev-parse', 'HEAD'], dir).trim()
      expect(headAfter).not.toBe(shaB)
      expect(headAfter).not.toBe(shaC)
      expect(git(['log', '-1', '--format=%s'], dir).trim()).toBe(restoreCommitMessage('B'))

      // Checkpoints antigos preservados intactos no histórico — nunca reescritos.
      expect(() => git(['cat-file', '-e', shaA], dir)).not.toThrow()
      expect(() => git(['cat-file', '-e', shaB], dir)).not.toThrow()
      expect(() => git(['cat-file', '-e', shaC], dir)).not.toThrow()
      expect(git(['log', '--format=%H'], dir)).toContain(shaC) // C ainda está na linha do tempo

      // O checkpoint E entrou na fila local — o "fluxo normal de checkpoint".
      const queueAfter = parseQueue(fs.readFileSync(queuePath, 'utf8'))
      const eRecord = queueAfter.find((r) => r.restoredFromCheckpointId === 'cpB')
      expect(eRecord).toBeDefined()
      expect(eRecord!.commitSha).toBe(headAfter)
      expect(eRecord!.pushStatus).toBe('local') // ainda não publicado
      expect(queueAfter).toHaveLength(4) // A, B, C preservados + E novo

      // Publicação normal: o MESMO pipeline de qualquer checkpoint —
      // processCheckpoint, sem nenhum caminho especial pro restore.
      const published: unknown[] = []
      const http: DaemonHttp = {
        publish: async (input) => {
          published.push(input)
          return { prNumber: 42 }
        },
        pollRestores: async () => [],
        reportRestoreApplied: async () => {},
        reportRestoreFailed: async () => {},
        syncStatus: async () => ({ latest: null }),
      }
      const ctx: DaemonContext = {
        projectId: 'proj-1',
        getSecret: () => 'sup_dev_ckpt_x',
        http,
        reader: defaultCommitReader(dir),
      }
      const publishOutcome = await processCheckpoint(eRecord!, ctx)
      expect(publishOutcome.result).toBe('done')
      expect(publishOutcome.record.pushStatus).toBe('published')
      expect(published).toHaveLength(1)
      expect((published[0] as { restoredFromCheckpointId?: string }).restoredFromCheckpointId).toBe(
        'cpB',
      )
    },
    20_000,
  )
})
