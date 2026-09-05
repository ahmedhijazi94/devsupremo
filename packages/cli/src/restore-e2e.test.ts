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
import { MANAGED_PATHS } from '../../../src/lib/templates/managed-paths'

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

/**
 * Regressão E2E real (git de verdade, teste-v3-12): checkpoint A sem
 * migration; depois foram criadas E APLICADAS duas migrations reais no
 * Supabase remoto (checkpoints B e C). Ao restaurar A, o preview voltava
 * corretamente e A virava "Ativo" — mas os dois arquivos de
 * `supabase/migrations/` eram REMOVIDOS do worktree, e a remoção entrava no
 * commit compensatório do restore. O Supabase remoto continuava com as duas
 * migrations aplicadas → o repo ficava PRA TRÁS do banco real, violando a
 * regra forward-only (migrations nunca desfazem schema; restore de código
 * nunca executa down migration). Migrations posteriores ao alvo devem
 * permanecer FISICAMENTE em `supabase/migrations/`, byte-idênticas, e fora
 * do commit compensatório — mesmo restaurando pra um checkpoint que não as
 * tinha.
 */
describe('restore — E2E real: migrations FORWARD-ONLY nunca são apagadas/revertidas pelo restore de código (v3-12)', () => {
  let dir: string

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
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
      changedPaths: [],
      ...over,
    }) as CheckpointRecord
  }

  it(
    'checkpoint A sem migration → B adiciona M1 → C adiciona M2 → restaurar A: código volta, M1/M2 continuam presentes e byte-idênticas, commit compensatório não as toca, nenhum rollback é executado',
    async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-restore-migrations-e2e-'))
      git(['init', '-q'], dir)
      git(['config', 'user.email', 'e2e@supremo.test'], dir)
      git(['config', 'user.name', 'Supremo E2E'], dir)
      fs.writeFileSync(path.join(dir, '.gitignore'), '.supremo/checkpoints/\n')
      fs.mkdirSync(path.join(dir, 'supabase', 'migrations'), { recursive: true })
      git(['add', '-A'], dir)
      git(['commit', '-q', '-m', 'chore: gitignore'], dir)

      // checkpoint A — FAQ, SEM nenhuma migration ainda (o ALVO do restore).
      fs.writeFileSync(path.join(dir, 'faq.txt'), 'FAQ v1\n')
      git(['add', '-A'], dir)
      git(['commit', '-q', '-m', 'checkpoint: A (FAQ)'], dir)
      const shaA = git(['rev-parse', 'HEAD'], dir).trim()

      // checkpoint B — cria E "aplica" (no Supabase remoto, fora do escopo
      // deste teste) a migration M1.
      const m1Content = '-- M1: cria tabela orders\ncreate table orders (id uuid primary key);\n'
      fs.writeFileSync(path.join(dir, 'supabase', 'migrations', '002_orders.sql'), m1Content)
      git(['add', '-A'], dir)
      git(['commit', '-q', '-m', 'checkpoint: B (migration M1)'], dir)
      const shaB = git(['rev-parse', 'HEAD'], dir).trim()

      // checkpoint C — cria E "aplica" a migration M2, e TAMBÉM muda o
      // código (senão restaurar pra A não teria nada de código a fazer,
      // dado que a única diferença seria migrations — que nunca contam).
      // HEAD atual.
      const m2Content = '-- M2: cria tabela products\ncreate table products (id uuid primary key);\n'
      fs.writeFileSync(path.join(dir, 'supabase', 'migrations', '003_products.sql'), m2Content)
      fs.writeFileSync(path.join(dir, 'faq.txt'), 'FAQ v2 (quebrado)\n')
      git(['add', '-A'], dir)
      git(['commit', '-q', '-m', 'checkpoint: C (migration M2 + FAQ quebrado)'], dir)
      const shaC = git(['rev-parse', 'HEAD'], dir).trim()

      const queue: CheckpointRecord[] = [
        queueRow({ checkpointId: 'cpA', commitSha: shaA, summary: 'A (FAQ)' }),
        queueRow({ checkpointId: 'cpB', commitSha: shaB, parentCheckpointId: 'cpA', summary: 'B (M1)' }),
        queueRow({ checkpointId: 'cpC', commitSha: shaC, parentCheckpointId: 'cpB', summary: 'C (M2)' }),
      ]
      const queuePath = path.join(dir, QUEUE_FILE)
      fs.mkdirSync(path.dirname(queuePath), { recursive: true })
      fs.writeFileSync(queuePath, serializeQueue(queue))

      const restoreDeps = defaultRestoreDeps(defaultCheckpointDeps(dir), dir)
      const outcome = applyRestore('cpA', 'A (FAQ)', 'proj-1', restoreDeps)

      // 5. código volta pra A.
      expect(outcome.applied).toBe(true)
      expect(fs.readFileSync(path.join(dir, 'faq.txt'), 'utf8')).toBe('FAQ v1\n')
      expect(git(['status', '--porcelain'], dir).trim()).toBe('')

      // 6. M1 e M2 continuam presentes e BYTE-IDÊNTICAS no worktree.
      const m1Path = path.join(dir, 'supabase', 'migrations', '002_orders.sql')
      const m2Path = path.join(dir, 'supabase', 'migrations', '003_products.sql')
      expect(fs.existsSync(m1Path)).toBe(true)
      expect(fs.existsSync(m2Path)).toBe(true)
      expect(fs.readFileSync(m1Path, 'utf8')).toBe(m1Content)
      expect(fs.readFileSync(m2Path, 'utf8')).toBe(m2Content)

      // preservedMigrations reporta as duas — nunca um conflito de conteúdo
      // (é o caso normal: elas só existem no estado atual, não em A).
      expect(outcome.preservedMigrations.sort()).toEqual(
        ['supabase/migrations/002_orders.sql', 'supabase/migrations/003_products.sql'].sort(),
      )
      expect(outcome.migrationConflicts).toEqual([])

      // 7. o commit compensatório (checkpoint E) NÃO contém deleção/
      // modificação de M1/M2 — o diff dele nunca menciona supabase/migrations.
      const headAfter = git(['rev-parse', 'HEAD'], dir).trim()
      expect(headAfter).not.toBe(shaA)
      expect(headAfter).not.toBe(shaC)
      const restoreCommitDiff = git(['diff', '--name-status', shaC, headAfter], dir)
      expect(restoreCommitDiff).not.toContain('supabase/migrations')
      const restoreCommitFiles = git(['diff', '--name-only', shaC, headAfter], dir)
      expect(restoreCommitFiles.split('\n').filter(Boolean)).toEqual(['faq.txt'])

      // As migrations continuam rastreadas pelo git (nunca removidas do
      // índice) e com o MESMO blob de conteúdo de quando foram commitadas em
      // B/C — prova, via git, de que nada foi reescrito.
      expect(git(['ls-files', 'supabase/migrations'], dir).trim().split('\n').sort()).toEqual(
        ['supabase/migrations/002_orders.sql', 'supabase/migrations/003_products.sql'].sort(),
      )
      const blobAtC = git(['rev-parse', `${shaC}:supabase/migrations/002_orders.sql`], dir).trim()
      const blobAtHead = git(['rev-parse', `${headAfter}:supabase/migrations/002_orders.sql`], dir).trim()
      expect(blobAtHead).toBe(blobAtC)

      // 8. nenhum comando de rollback/down migration é executado — o restore
      // não sabe nada sobre Supabase; só git. A migration original de A
      // (inexistente) nunca foi "recriada"/tocada por nenhum caminho.
      const gitLogAllFiles = git(['log', '--name-only', '--format='], dir)
      expect(gitLogAllFiles).not.toMatch(/down|rollback/i)

      // checkpoints antigos preservados intactos — nunca reescritos.
      expect(() => git(['cat-file', '-e', shaA], dir)).not.toThrow()
      expect(() => git(['cat-file', '-e', shaB], dir)).not.toThrow()
      expect(() => git(['cat-file', '-e', shaC], dir)).not.toThrow()
    },
    20_000,
  )

  it(
    'fail-closed: migration EXISTENTE com conteúdo divergente entre atual e alvo (editada in-place, nunca deveria acontecer) → conteúdo ATUAL preservado, nunca reescrito pro conteúdo antigo, e sinalizado como conflito',
    async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-restore-migrations-e2e-'))
      git(['init', '-q'], dir)
      git(['config', 'user.email', 'e2e@supremo.test'], dir)
      git(['config', 'user.name', 'Supremo E2E'], dir)
      fs.writeFileSync(path.join(dir, '.gitignore'), '.supremo/checkpoints/\n')
      fs.mkdirSync(path.join(dir, 'supabase', 'migrations'), { recursive: true })
      git(['add', '-A'], dir)
      git(['commit', '-q', '-m', 'chore: gitignore'], dir)

      // checkpoint A — já tem a migration M1, versão ORIGINAL.
      const originalM1 = '-- M1 original\ncreate table orders (id uuid primary key);\n'
      fs.writeFileSync(path.join(dir, 'supabase', 'migrations', '001_orders.sql'), originalM1)
      fs.writeFileSync(path.join(dir, 'faq.txt'), 'FAQ v1\n')
      git(['add', '-A'], dir)
      git(['commit', '-q', '-m', 'checkpoint: A (M1 original)'], dir)
      const shaA = git(['rev-parse', 'HEAD'], dir).trim()

      // checkpoint B — edita a migration JÁ EXISTENTE in-place (anti-padrão;
      // nunca deveria acontecer num fluxo forward-only real, mas prova que o
      // restore nunca reescreve silenciosamente mesmo nesse caso). HEAD atual.
      const editedM1 = '-- M1 EDITADA depois de já commitada (nao deveria acontecer)\ncreate table orders (id uuid primary key, total numeric);\n'
      fs.writeFileSync(path.join(dir, 'supabase', 'migrations', '001_orders.sql'), editedM1)
      fs.writeFileSync(path.join(dir, 'faq.txt'), 'FAQ v2\n')
      git(['add', '-A'], dir)
      git(['commit', '-q', '-m', 'checkpoint: B (edita M1 in-place + FAQ)'], dir)
      const shaB = git(['rev-parse', 'HEAD'], dir).trim()

      const queue: CheckpointRecord[] = [
        queueRow({ checkpointId: 'cpA', commitSha: shaA, summary: 'A (M1 original)' }),
        queueRow({ checkpointId: 'cpB', commitSha: shaB, parentCheckpointId: 'cpA', summary: 'B' }),
      ]
      const queuePath = path.join(dir, QUEUE_FILE)
      fs.mkdirSync(path.dirname(queuePath), { recursive: true })
      fs.writeFileSync(queuePath, serializeQueue(queue))

      const restoreDeps = defaultRestoreDeps(defaultCheckpointDeps(dir), dir)
      const outcome = applyRestore('cpA', 'A (M1 original)', 'proj-1', restoreDeps)

      expect(outcome.applied).toBe(true)
      // FAQ volta pro estado de A normalmente — só o código de fato muda.
      expect(fs.readFileSync(path.join(dir, 'faq.txt'), 'utf8')).toBe('FAQ v1\n')

      // A migration NUNCA é reescrita pro conteúdo antigo de A — o conteúdo
      // ATUAL (de B, editado) é o que fica, intacto.
      const m1Path = path.join(dir, 'supabase', 'migrations', '001_orders.sql')
      expect(fs.readFileSync(m1Path, 'utf8')).toBe(editedM1)
      expect(fs.readFileSync(m1Path, 'utf8')).not.toBe(originalM1)

      // sinalizado como CONFLITO (conteúdo divergente, não só ausência) —
      // preservada do mesmo jeito, mas o chamador sabe que é um caso raro.
      expect(outcome.preservedMigrations).toEqual(['supabase/migrations/001_orders.sql'])
      expect(outcome.migrationConflicts).toEqual(['supabase/migrations/001_orders.sql'])

      // o commit compensatório não toca a migration.
      const headAfter = git(['rev-parse', 'HEAD'], dir).trim()
      const restoreCommitDiff = git(['diff', '--name-status', shaB, headAfter], dir)
      expect(restoreCommitDiff).not.toContain('supabase/migrations')
    },
    20_000,
  )
})

/**
 * Regressão E2E v3-18: depois de smoke e workflow receberem hotfixes na main,
 * restaurar um checkpoint anterior também restaurava as versões defeituosas
 * desses rails. O conteúdo da página deve voltar, mas infraestrutura gerenciada
 * e migrations precisam permanecer exatamente como estão no workspace atual.
 */
describe('restore — E2E real: conteúdo volta, infraestrutura gerenciada permanece atual (v3-18)', () => {
  let dir: string

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  function git(args: string[]): string {
    return execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  function queueRow(over: Partial<CheckpointRecord>): CheckpointRecord {
    return buildCheckpointRecord({
      checkpointId: 'placeholder',
      projectId: 'proj-1',
      commitSha: 'placeholder',
      parentCheckpointId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      summary: 'placeholder',
      changedPaths: [],
      ...over,
    }) as CheckpointRecord
  }

  it('restaura código do usuário sem fazer downgrade de smoke, workflow ou migrations', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-restore-managed-e2e-'))
    git(['init', '-q'])
    git(['config', 'user.email', 'e2e@supremo.test'])
    git(['config', 'user.name', 'Supremo E2E'])

    fs.mkdirSync(path.join(dir, 'app'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true })
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'supabase', 'migrations'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.gitignore'), '.supremo/checkpoints/\n')

    const oldPage = 'export default function Page() { return <main><h1>Landing antiga</h1></main> }\n'
    const oldSmoke =
      "await expect(page.getByRole('heading', { level: 1, name: 'v3-18' })).toBeVisible()\n"
    const oldWorkflow = 'uses: supabase/setup-cli@v1\nwith:\n  version: latest\n'
    const initialMigration = '-- schema inicial\ncreate table profiles (id uuid primary key);\n'

    // Checkpoint antigo: conteúdo e rails anteriores aos hotfixes.
    fs.writeFileSync(path.join(dir, 'app', 'page.tsx'), oldPage)
    fs.writeFileSync(path.join(dir, 'e2e', 'smoke.spec.ts'), oldSmoke)
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), oldWorkflow)
    fs.writeFileSync(
      path.join(dir, 'supabase', 'migrations', '001_initial.sql'),
      initialMigration,
    )
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'checkpoint: A (antes dos hotfixes)'])
    const shaA = git(['rev-parse', 'HEAD']).trim()

    const currentPage =
      'export default function Page() { return <main><h1>Horizonte atual</h1></main> }\n'
    const currentSmoke =
      "await expect(page.locator('main')).toBeVisible()\nawait expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()\n"
    const currentWorkflow =
      'run: npm ci\nrun: ./node_modules/.bin/supabase db lint --level error\n'
    const currentMigration = '-- evolução atual\nalter table profiles add column name text;\n'

    // Estado atual: conteúdo novo, rails corrigidos e migration posterior.
    fs.writeFileSync(path.join(dir, 'app', 'page.tsx'), currentPage)
    fs.writeFileSync(path.join(dir, 'e2e', 'smoke.spec.ts'), currentSmoke)
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), currentWorkflow)
    fs.writeFileSync(
      path.join(dir, 'supabase', 'migrations', '002_add_name.sql'),
      currentMigration,
    )
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'checkpoint: B (hotfixes atuais)'])
    const shaB = git(['rev-parse', 'HEAD']).trim()

    const queue = [
      queueRow({ checkpointId: 'cpA', commitSha: shaA, summary: 'A antigo' }),
      queueRow({
        checkpointId: 'cpB',
        commitSha: shaB,
        parentCheckpointId: 'cpA',
        summary: 'B atual',
      }),
    ]
    const queuePath = path.join(dir, QUEUE_FILE)
    fs.mkdirSync(path.dirname(queuePath), { recursive: true })
    fs.writeFileSync(queuePath, serializeQueue(queue))

    const outcome = applyRestore(
      'cpA',
      'A antigo',
      'proj-1',
      defaultRestoreDeps(defaultCheckpointDeps(dir), dir),
    )

    expect(outcome.applied).toBe(true)
    expect(outcome.record?.restoredFromCheckpointId).toBe('cpA')
    expect(fs.readFileSync(path.join(dir, 'app', 'page.tsx'), 'utf8')).toBe(oldPage)
    expect(fs.readFileSync(path.join(dir, 'e2e', 'smoke.spec.ts'), 'utf8')).toBe(currentSmoke)
    expect(fs.readFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'utf8')).toBe(
      currentWorkflow,
    )
    expect(
      fs.readFileSync(path.join(dir, 'supabase', 'migrations', '001_initial.sql'), 'utf8'),
    ).toBe(initialMigration)
    expect(
      fs.readFileSync(path.join(dir, 'supabase', 'migrations', '002_add_name.sql'), 'utf8'),
    ).toBe(currentMigration)

    const headAfter = git(['rev-parse', 'HEAD']).trim()
    expect(headAfter).not.toBe(shaA)
    expect(headAfter).not.toBe(shaB)
    const restoredPaths = git(['diff', '--name-only', shaB, headAfter])
      .split('\n')
      .filter(Boolean)
    expect(restoredPaths).toEqual(['app/page.tsx'])
    for (const managedPath of MANAGED_PATHS) {
      expect(restoredPaths).not.toContain(managedPath)
    }
    expect(restoredPaths.some((file) => file.startsWith('supabase/migrations/'))).toBe(false)
    expect(git(['status', '--porcelain']).trim()).toBe('')
  })
})
