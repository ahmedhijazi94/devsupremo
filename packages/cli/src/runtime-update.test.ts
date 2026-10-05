import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyToolUpdate, planToolUpdate, readToolUpdate, type ToolUpdateDeps } from './runtime-update'
import { inspectRuntimeVersions } from './runtime-version'
import { launchAgentPlist, serviceStatus } from './runtime-service'
import { gitText, writeJson } from './turn-workspace'
import { reconcileAbandonedHost } from './host-recovery'
import { enqueueDatabaseOperation } from './durable-operations'

let cwd: string, base: string, target: string
const bundle = 'tools/supremo-cli/dist/bin.js'
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-runtime-update-'))
  gitText(cwd, ['init', '-b', 'main']); gitText(cwd, ['config', 'user.name', 'Fixture']); gitText(cwd, ['config', 'user.email', 'test@example.invalid'])
  fs.mkdirSync(path.join(cwd, 'tools/supremo-cli/dist'), { recursive: true })
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.supremo/\nnode_modules/\n')
  fs.writeFileSync(path.join(cwd, 'tools/supremo-cli/package.json'), JSON.stringify({ name: 'supremo-cli', version: '1.13.0' }) + '\n')
  fs.writeFileSync(path.join(cwd, bundle), 'console.log("old");\n')
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'original app\n')
  gitText(cwd, ['add', '.']); gitText(cwd, ['commit', '-m', 'base']); base = gitText(cwd, ['rev-parse', 'HEAD'])
  fs.writeFileSync(path.join(cwd, bundle), 'console.log("new");\n')
  gitText(cwd, ['add', '.']); gitText(cwd, ['commit', '-m', 'tools']); target = gitText(cwd, ['rev-parse', 'HEAD'])
  gitText(cwd, ['checkout', base, '--', bundle])
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(cwd, { recursive: true, force: true }) })
function deps(): ToolUpdateDeps { return { validate: vi.fn(async () => {}), stop: vi.fn(async () => true), start: vi.fn(async () => {}), active: () => true } }
it('updates tools transactionally while preserving preview files, user source, HEAD and staging', async () => {
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'user draft\n')
  writeJson(path.join(cwd, '.supremo/preview.json'), { pid: 77, port: 3000 })
  const head = gitText(cwd, ['rev-parse', 'HEAD']), index = gitText(cwd, ['diff', '--cached'])
  const plan = planToolUpdate(cwd, base, target), calls = deps()
  expect((await applyToolUpdate(cwd, plan.id, calls)).status).toBe('active')
  expect(fs.readFileSync(path.join(cwd, bundle), 'utf8')).toContain('new')
  expect(fs.readFileSync(path.join(cwd, 'feature.txt'), 'utf8')).toBe('user draft\n')
  expect(fs.readFileSync(path.join(cwd, '.supremo/preview.json'), 'utf8')).toContain('3000')
  expect(gitText(cwd, ['rev-parse', 'HEAD'])).toBe(head); expect(gitText(cwd, ['diff', '--cached'])).toBe(index)
  await applyToolUpdate(cwd, plan.id, calls)
  expect(calls.validate).toHaveBeenCalledTimes(1)
})
it('refuses personalization and concurrent edits before any daemon is stopped', async () => {
  const plan = planToolUpdate(cwd, base, target), calls = deps()
  fs.writeFileSync(path.join(cwd, bundle), 'custom\n')
  expect(() => planToolUpdate(cwd, base, target)).toThrow('Personalização')
  expect((await applyToolUpdate(cwd, plan.id, calls)).status).toBe('conflict')
  expect(calls.stop).not.toHaveBeenCalled()
  expect(fs.readFileSync(path.join(cwd, bundle), 'utf8')).toBe('custom\n')
})
it('preserves the live preview when a candidate needs different application dependencies', async () => {
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { react: '19.0.0' } }))
  gitText(cwd, ['add', 'package.json']); gitText(cwd, ['commit', '-m', 'package base']); const packageBase = gitText(cwd, ['rev-parse', 'HEAD'])
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { react: '19.2.0' } }))
  gitText(cwd, ['add', 'package.json']); gitText(cwd, ['commit', '-m', 'package target']); const packageTarget = gitText(cwd, ['rev-parse', 'HEAD'])
  gitText(cwd, ['checkout', packageBase, '--', 'package.json'])
  const plan = planToolUpdate(cwd, packageBase, packageTarget), calls = deps()
  await expect(applyToolUpdate(cwd, plan.id, calls)).rejects.toThrow('instalação isolada')
  expect(calls.stop).not.toHaveBeenCalled(); expect(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).toContain('19.0.0')
  expect(readToolUpdate(cwd, plan.id)).toMatchObject({ status: 'planned', error: expect.stringContaining(plan.id) })
})
it('rolls back failed activation without reverting application changes', async () => {
  const plan = planToolUpdate(cwd, base, target), calls = deps()
  calls.start = async () => { throw new Error('startup failed') }
  expect((await applyToolUpdate(cwd, plan.id, calls)).status).toBe('rolled_back')
  expect(fs.readFileSync(path.join(cwd, bundle), 'utf8')).toContain('old')
  expect(readToolUpdate(cwd, plan.id).error).toBe('startup failed')
})
it('never overwrites a concurrent edit made after application even on rollback', async () => {
  const plan = planToolUpdate(cwd, base, target), calls = deps()
  calls.start = async () => { fs.writeFileSync(path.join(cwd, bundle), 'user changed after apply\n'); throw new Error('startup failed') }
  expect((await applyToolUpdate(cwd, plan.id, calls)).status).toBe('conflict')
  expect(fs.readFileSync(path.join(cwd, bundle), 'utf8')).toContain('user changed after apply')
})
it('blocks rollback to an older queue protocol after a new durable operation was accepted', async () => {
  const plan = planToolUpdate(cwd, base, target), calls = deps()
  calls.start = async () => { enqueueDatabaseOperation(cwd, 'status', {}); throw new Error('startup failed after accepting work') }
  const result = await applyToolUpdate(cwd, plan.id, calls)
  expect(result.status).toBe('conflict'); expect(result.error).toContain('Downgrade bloqueado')
  expect(fs.readFileSync(path.join(cwd, bundle), 'utf8')).toContain('new')
})
it('detects a bundled update that the running daemon has not loaded', () => {
  fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true })
  fs.symlinkSync(path.join(cwd, 'tools/supremo-cli'), path.join(cwd, 'node_modules/supremo-cli'))
  writeJson(path.join(cwd, '.supremo/checkpoints/runtime.json'), { protocolVersion: 1, queueProtocol: 2, pid: process.pid, startedAt: Date.now(), version: '1.13.0',
    digest: crypto.createHash('sha256').update(fs.readFileSync(path.join(cwd, bundle))).digest('hex') })
  fs.writeFileSync(path.join(cwd, '.supremo/checkpoints/daemon.pid'), String(process.pid))
  expect(inspectRuntimeVersions(cwd).compatible).toBe(true)
  fs.writeFileSync(path.join(cwd, bundle), 'changed after launch\n')
  expect(inspectRuntimeVersions(cwd)).toMatchObject({ compatible: false, updateRequired: true })
})
it('uses an explicit user service and escapes arguments instead of generating a shell command', () => {
  const plist = launchAgentPlist('/Users/Test & Owner/app', '/node', 'app.supremo.test')
  expect(plist).toContain('Test &amp; Owner'); expect(plist).toContain('<string>runtime</string><string>supervise</string>')
  expect(serviceStatus(cwd)).toMatchObject({ mode: 'host', state: 'not_installed' })
})
it('recovers a dead host only when no tool may still be mutating the workspace', async () => {
  writeJson(path.join(cwd, '.supremo/turns/state.json'), { hostPid: 987654, turn: { status: 'active' } })
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }) })
  writeJson(path.join(cwd, '.supremo/turns/mutation-lease.json'), { toolUseId: 'maybe-active' })
  expect(await reconcileAbandonedHost(cwd)).toBe(false)
  fs.rmSync(path.join(cwd, '.supremo/turns/mutation-lease.json'))
  expect(await reconcileAbandonedHost(cwd)).toBe(true)
  expect(JSON.parse(fs.readFileSync(path.join(cwd, '.supremo/turns/state.json'), 'utf8'))).toMatchObject({ turn: { status: 'blocked' } })
})
