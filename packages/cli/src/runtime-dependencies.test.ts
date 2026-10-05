import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyToolUpdate, planToolUpdate, readToolUpdate, type ToolUpdateDeps } from './runtime-update'
import { assertPreviewStopped, installDependencyCandidate, portIsClosed, prepareDependencySwap, restoreDependencies, swapDependencies } from './runtime-dependencies'
import { gitText, writeJson } from './turn-workspace'
import * as workers from './worker-process'
import * as runtimes from './project-runtime'

let cwd: string, base: string, target: string
let port: number
beforeEach(async () => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-dependencies-'))
  gitText(cwd, ['init', '-b', 'main']); gitText(cwd, ['config', 'user.name', 'Fixture']); gitText(cwd, ['config', 'user.email', 'test@example.invalid'])
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.supremo/\nnode_modules/\n')
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { react: '19.0.0' } }))
  fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/react': { version: '19.0.0' } } }))
  gitText(cwd, ['add', '.']); gitText(cwd, ['commit', '-m', 'base']); base = gitText(cwd, ['rev-parse', 'HEAD'])
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { react: '19.2.0' } }))
  fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/react': { version: '19.2.0' } } }))
  gitText(cwd, ['add', '.']); gitText(cwd, ['commit', '-m', 'candidate']); target = gitText(cwd, ['rev-parse', 'HEAD'])
  gitText(cwd, ['checkout', base, '--', 'package.json', 'package-lock.json'])
  fs.mkdirSync(path.join(cwd, 'node_modules'))
  fs.writeFileSync(path.join(cwd, 'node_modules/version'), 'before')
  fs.mkdirSync(path.join(cwd, '.supremo'), { recursive: true })
  // Allocate and close a real loopback port; no mocked socket claims success.
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  port = (server.address() as net.AddressInfo).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  fs.writeFileSync(path.join(cwd, '.supremo/preview.pid'), '987654321')
  fs.writeFileSync(path.join(cwd, '.supremo/preview.port'), String(port))
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(cwd, { recursive: true, force: true }) })
const install = async (_cwd: string, scratch: string): Promise<void> => {
  fs.mkdirSync(path.join(scratch, 'node_modules'))
  fs.writeFileSync(path.join(scratch, 'node_modules/version'), 'after')
}
const deps = (): ToolUpdateDeps => ({ validate: vi.fn(async () => {}), stop: vi.fn(async () => true), start: vi.fn(async () => {}), active: () => true, installDependencies: install })
const version = (): string => fs.readFileSync(path.join(cwd, 'node_modules/version'), 'utf8')

it('requires explicit dependency scope and proves the remembered process stopped even after stop removed its receipt', async () => {
  fs.writeFileSync(path.join(cwd, '.supremo/preview.pid'), String(process.pid))
  const plan = planToolUpdate(cwd, base, target), calls = deps()
  await expect(applyToolUpdate(cwd, plan.id, calls)).rejects.toThrow('--with-dependencies')
  fs.rmSync(path.join(cwd, '.supremo/preview.pid')); fs.rmSync(path.join(cwd, '.supremo/preview.port'))
  await expect(applyToolUpdate(cwd, plan.id, calls, { withDependencies: true })).rejects.toThrow('PID encerrado')
  expect(version()).toBe('before'); expect(calls.stop).not.toHaveBeenCalled()
})

it('refuses missing preview evidence, a live port and indeterminate process state', async () => {
  await expect(assertPreviewStopped(cwd, undefined)).rejects.toThrow('faltou a prova')
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  try {
    expect(await portIsClosed(port)).toBe(false)
    await expect(assertPreviewStopped(cwd, { pid: 987654321, port })).rejects.toThrow('porta fechada')
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('unknown'), { code: 'EPERM' }) })
  await expect(assertPreviewStopped(cwd, { pid: 987654321, port })).rejects.toThrow('PID encerrado')
})

it('installs outside the live tree, swaps after stop and retains old modules, queue, application draft and git index', async () => {
  fs.writeFileSync(path.join(cwd, 'draft.txt'), 'unsaved application change')
  writeJson(path.join(cwd, '.supremo/database-queue/operations/fixture.json'), { status: 'uncertain' })
  const queue = fs.readFileSync(path.join(cwd, '.supremo/database-queue/operations/fixture.json'), 'utf8')
  const index = gitText(cwd, ['diff', '--cached']), head = gitText(cwd, ['rev-parse', 'HEAD'])
  const plan = planToolUpdate(cwd, base, target), calls = deps()
  calls.installDependencies = async (root, scratch) => {
    expect(root).toBe(cwd); expect(scratch).not.toBe(cwd); expect(version()).toBe('before')
    expect(fs.readFileSync(path.join(scratch, 'package.json'), 'utf8')).toContain('19.2.0')
    expect(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).toContain('19.0.0')
    await install(root, scratch)
  }
  const result = await applyToolUpdate(cwd, plan.id, calls, { withDependencies: true })
  expect(result.status).toBe('active'); expect(result.dependencies?.state).toBe('installed'); expect(version()).toBe('after')
  expect(fs.readFileSync(path.join(cwd, `.supremo/runtime-update/modules-${plan.id}-before/version`), 'utf8')).toBe('before')
  expect(fs.readFileSync(path.join(cwd, 'draft.txt'), 'utf8')).toContain('unsaved')
  expect(fs.readFileSync(path.join(cwd, '.supremo/database-queue/operations/fixture.json'), 'utf8')).toBe(queue)
  expect(gitText(cwd, ['diff', '--cached'])).toBe(index); expect(gitText(cwd, ['rev-parse', 'HEAD'])).toBe(head)
  expect((await applyToolUpdate(cwd, plan.id, calls)).status).toBe('active')
  expect(calls.stop).toHaveBeenCalledTimes(1)
})

it('rechecks preview after candidate installation and leaves the installation untouched if preview restarted', async () => {
  const plan = planToolUpdate(cwd, base, target), calls = deps()
  calls.installDependencies = async (root, scratch) => { await install(root, scratch); fs.writeFileSync(path.join(cwd, '.supremo/preview.pid'), String(process.pid)) }
  await expect(applyToolUpdate(cwd, plan.id, calls, { withDependencies: true })).rejects.toThrow('PID encerrado')
  expect(version()).toBe('before'); expect(calls.stop).not.toHaveBeenCalled()
  expect(readToolUpdate(cwd, plan.id).dependencies?.state).toBe('prepared')
})

it('rolls back modules and manifests on failed activation', async () => {
  const plan = planToolUpdate(cwd, base, target), calls = deps()
  calls.start = async () => { expect(version()).toBe('after'); throw new Error('candidate activation failed') }
  const result = await applyToolUpdate(cwd, plan.id, calls, { withDependencies: true })
  expect(result.status).toBe('rolled_back'); expect(result.dependencies?.state).toBe('rolled_back')
  expect(version()).toBe('before'); expect(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).toContain('19.0.0')
})

it('preserves a concurrent replacement during rollback', async () => {
  const plan = planToolUpdate(cwd, base, target), calls = deps()
  calls.start = async () => {
    fs.renameSync(path.join(cwd, 'node_modules'), path.join(cwd, 'candidate-moved'))
    fs.mkdirSync(path.join(cwd, 'node_modules')); fs.writeFileSync(path.join(cwd, 'node_modules/version'), 'concurrent')
    throw new Error('activation failed')
  }
  const result = await applyToolUpdate(cwd, plan.id, calls, { withDependencies: true })
  expect(result.status).toBe('conflict'); expect(version()).toBe('concurrent')
  expect(result.error).toContain('instalação concorrente')
})

it('resumes a crash after the first rename and rolls back without deleting either installation', async () => {
  const plan = planToolUpdate(cwd, base, target)
  const journal = await prepareDependencySwap(cwd, plan.id, target, install)
  journal.state = 'swapping'
  fs.renameSync(path.join(cwd, 'node_modules'), path.join(cwd, `.supremo/runtime-update/modules-${plan.id}-before`))
  const persist = vi.fn()
  swapDependencies(cwd, plan.id, journal, persist)
  expect(version()).toBe('after'); expect(journal.state).toBe('installed')
  swapDependencies(cwd, plan.id, journal, persist)
  restoreDependencies(cwd, plan.id, journal, persist)
  expect(version()).toBe('before'); expect(journal.state).toBe('rolled_back')
  restoreDependencies(cwd, plan.id, journal, persist)
  expect(version()).toBe('before')
})

it('resumes after the second swap rename and after the first rollback rename', async () => {
  const plan = planToolUpdate(cwd, base, target)
  const journal = await prepareDependencySwap(cwd, plan.id, target, install)
  const before = path.join(cwd, `.supremo/runtime-update/modules-${plan.id}-before`)
  const staged = path.join(cwd, `.supremo/runtime-update/dependencies-${plan.id}/node_modules`)
  journal.state = 'swapping'
  fs.renameSync(path.join(cwd, 'node_modules'), before)
  fs.renameSync(staged, path.join(cwd, 'node_modules'))
  swapDependencies(cwd, plan.id, journal, () => {})
  expect(journal.state).toBe('installed'); expect(version()).toBe('after')
  fs.renameSync(path.join(cwd, 'node_modules'), staged)
  restoreDependencies(cwd, plan.id, journal, () => {})
  expect(journal.state).toBe('rolled_back'); expect(version()).toBe('before')
})

it('detects a lockfile-only dependency change and refuses a concurrent installation before swapping', async () => {
  gitText(cwd, ['checkout', base, '--', 'package.json'])
  gitText(cwd, ['checkout', target, '--', 'package-lock.json'])
  gitText(cwd, ['add', 'package.json']); gitText(cwd, ['commit', '-m', 'keep manifest'])
  const lockTarget = gitText(cwd, ['rev-parse', 'HEAD'])
  gitText(cwd, ['checkout', base, '--', 'package-lock.json'])
  const plan = planToolUpdate(cwd, base, lockTarget), calls = deps()
  await expect(applyToolUpdate(cwd, plan.id, calls)).rejects.toThrow('--with-dependencies')
  calls.installDependencies = async (root, scratch) => { await install(root, scratch); fs.writeFileSync(path.join(cwd, 'node_modules/.package-lock.json'), '{"changed":true}') }
  expect((await applyToolUpdate(cwd, plan.id, calls, { withDependencies: true })).status).toBe('conflict')
  expect(version()).toBe('before'); expect(fs.readFileSync(path.join(cwd, 'node_modules/.package-lock.json'), 'utf8')).toContain('changed')
})

it('rejects symlinked live modules and isolated installs outside the public registry before executing npm', async () => {
  const plan = planToolUpdate(cwd, base, target)
  fs.renameSync(path.join(cwd, 'node_modules'), path.join(cwd, 'original-modules'))
  fs.symlinkSync(path.join(cwd, 'original-modules'), path.join(cwd, 'node_modules'))
  await expect(prepareDependencySwap(cwd, plan.id, target, install)).rejects.toThrow('diretórios regulares')
  fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/react': { resolved: 'https://private.example.invalid/react.tgz', integrity: 'fixture' } } }))
  await expect(installDependencyCandidate(cwd, cwd)).rejects.toThrow('registry público')
})

it('never runs checkout hooks or configured filters while preparing the isolated candidate', async () => {
  fs.writeFileSync(path.join(cwd, '.gitattributes'), 'package.json filter=fixture\n')
  gitText(cwd, ['add', '.gitattributes']); gitText(cwd, ['commit', '-m', 'filter fixture'])
  const filterTarget = gitText(cwd, ['rev-parse', 'HEAD'])
  const id = 'a1c887da-2c33-4c6a-a233-7afba1f44eec'
  fs.writeFileSync(path.join(cwd, '.git/hooks/post-checkout'), '#!/bin/sh\ntouch "$PWD/hook-ran"\n', { mode: 0o755 })
  gitText(cwd, ['config', 'filter.fixture.smudge', 'touch "$PWD/filter-ran"; cat'])
  gitText(cwd, ['config', 'filter.fixture.required', 'true'])
  await prepareDependencySwap(cwd, id, filterTarget, install)
  expect(fs.existsSync(path.join(cwd, `.supremo/runtime-update/dependencies-${id}/hook-ran`))).toBe(false)
  expect(fs.existsSync(path.join(cwd, `.supremo/runtime-update/dependencies-${id}/filter-ran`))).toBe(false)
})

it('runs npm with hooks disabled, isolated configuration and no ambient runtime environment', async () => {
  fs.writeFileSync(path.join(cwd, '.npmrc'), 'registry=https://private.example.invalid\n')
  fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/react': { resolved: 'https://registry.npmjs.org/react/-/react-19.0.0.tgz', integrity: 'fixture' } } }))
  vi.spyOn(runtimes, 'lookupProjectRuntime').mockResolvedValue({ node: process.execPath, npm: '/fixture/npm-cli.js', env: { PRIVATE_TEST_VALUE: 'fixture-only' }, version: '22.22.1', source: 'current' })
  const run = vi.spyOn(workers, 'runWorkerProcess').mockResolvedValue({ stdout: '', stderr: '' })
  await installDependencyCandidate(cwd, cwd)
  expect(run).toHaveBeenCalledTimes(2)
  expect(run.mock.calls[0]?.[1]).toContain('--ignore-scripts')
  expect(run.mock.calls[0]?.[1]).toContain('--registry=https://registry.npmjs.org/')
  expect(run.mock.calls[0]?.[2].env).not.toHaveProperty('PRIVATE_TEST_VALUE')
  expect(Object.keys(run.mock.calls[0]?.[2].env ?? {}).sort()).toEqual(['CI', 'HOME', 'PATH', 'TMPDIR'])
  expect(fs.existsSync(path.join(cwd, '.npmrc'))).toBe(false)
  run.mockRejectedValue(new Error('fixture provider diagnostics'))
  await expect(installDependencyCandidate(cwd, cwd)).rejects.toThrow('Instalação isolada não validou')
})
