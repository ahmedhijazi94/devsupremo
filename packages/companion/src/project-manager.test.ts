import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectManager } from './project-manager'
import type { DevHandle, Runner } from './runner'
import type { GitOps } from './git'
import type { CompanionEvent } from './protocol'

const USER = '11111111-1111-4111-8111-111111111111'
const PROJ = 'aaaaaaaa-1111-4111-8111-111111111111'

class FakeRunner implements Runner {
  execCalls: string[][] = []
  startCalls = 0
  async exec(cmd: string[]): Promise<number> {
    this.execCalls.push(cmd)
    return 0
  }
  async startDev(_cmd: string[], _cwd: string, port: number): Promise<DevHandle> {
    this.startCalls++
    return { port, url: `http://localhost:${port}`, stop: async () => {}, onExit: () => {} }
  }
}

class FakeGit implements GitOps {
  cloneCalls = 0
  async clone(_url: string, _token: string, dir: string): Promise<void> {
    this.cloneCalls++
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
  }
  async pull(): Promise<void> {}
  async status(): Promise<string> {
    return ''
  }
  async commitAndPush(): Promise<void> {}
}

describe('ProjectManager', () => {
  let base: string
  let runner: FakeRunner
  let git: FakeGit
  let events: CompanionEvent[]
  let manager: ProjectManager

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'supremo-ws-'))
    runner = new FakeRunner()
    git = new FakeGit()
    events = []
    manager = new ProjectManager({
      userId: USER,
      workspaceBase: base,
      runner,
      git,
      emit: (e) => events.push(e),
    })
  })

  afterEach(async () => {
    await manager.stopAll()
    await rm(base, { recursive: true, force: true })
  })

  const startCmd = {
    projectId: PROJ,
    repoFullName: 'owner/repo',
    branch: 'main',
    cloneToken: 'sup_fake_token_123',
  }

  it('clona quando não há .git, instala quando falta node_modules, e sobe o preview', async () => {
    await manager.start(startCmd)

    expect(git.cloneCalls).toBe(1)
    expect(runner.execCalls.some((c) => c[0] === 'npm' && c[1] === 'ci')).toBe(true)
    expect(runner.startCalls).toBe(1)
    expect(events.some((e) => e.type === 'preview_ready')).toBe(true)
    expect(
      events.some((e) => e.type === 'runtime_status' && e.status === 'online'),
    ).toBe(true)
  })

  it('idempotente: já online, reanuncia o preview sem clonar de novo', async () => {
    await manager.start(startCmd)
    const before = git.cloneCalls
    events.length = 0

    await manager.start(startCmd)

    expect(git.cloneCalls).toBe(before) // não clonou de novo
    expect(events.filter((e) => e.type === 'preview_ready')).toHaveLength(1)
  })

  it('apply_edits escreve no filesystem do projeto', async () => {
    await manager.applyEdits(PROJ, [
      { path: 'app/page.tsx', content: 'export default () => null' },
    ])
    const written = join(base, USER, PROJ, 'app/page.tsx')
    expect(existsSync(written)).toBe(true)
    expect(await readFile(written, 'utf8')).toContain('export default')
  })

  it('apply_edits REJEITA escrever fora do projeto (traversal)', async () => {
    await expect(
      manager.applyEdits(PROJ, [{ path: '../../evil.txt', content: 'x' }]),
    ).rejects.toThrow()
  })

  it('apply_edits com content:null apaga o arquivo', async () => {
    await manager.applyEdits(PROJ, [{ path: 'tmp.txt', content: 'a' }])
    const p = join(base, USER, PROJ, 'tmp.txt')
    expect(existsSync(p)).toBe(true)
    await manager.applyEdits(PROJ, [{ path: 'tmp.txt', content: null }])
    expect(existsSync(p)).toBe(false)
  })
})
