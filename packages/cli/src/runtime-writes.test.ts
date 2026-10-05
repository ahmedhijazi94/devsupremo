import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { measureRuntime } from './runtime-metrics'
import { writeLaunchAgentPlist } from './runtime-service'

let cwd: string
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-runtime-writes-')) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(cwd, { recursive: true, force: true }) })
const metricsFile = () => path.join(cwd, '.supremo/runtime-metrics/events.jsonl')

it('writes bounded metrics through the same opened inode even if its pathname is replaced', async () => {
  await measureRuntime(cwd, 'database', async () => 'initial')
  const file = metricsFile(), previous = path.join(cwd, 'original-events.jsonl'), victim = path.join(cwd, 'private.txt')
  fs.writeFileSync(victim, 'preserve')
  const inspect = fs.fstatSync
  vi.spyOn(fs, 'fstatSync').mockImplementationOnce((...args: Parameters<typeof fs.fstatSync>) => {
    const stat = inspect(...args)
    fs.renameSync(file, previous); fs.symlinkSync(victim, file)
    return stat
  })
  expect(await measureRuntime(cwd, 'validation', async () => 'result')).toBe('result')
  expect(fs.readFileSync(victim, 'utf8')).toBe('preserve')
  expect(fs.readFileSync(previous, 'utf8').trim().split('\n')).toHaveLength(2)
})

it.each(['symbolic', 'hard'] as const)('does not append metrics through a %s link', async kind => {
  const file = metricsFile(), victim = path.join(cwd, 'private.txt')
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(victim, 'preserve')
  if (kind === 'symbolic') fs.symlinkSync(victim, file)
  else fs.linkSync(victim, file)
  const diagnostics = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  expect(await measureRuntime(cwd, 'database', async () => 'result')).toBe('result')
  expect(fs.readFileSync(victim, 'utf8')).toBe('preserve')
  expect(diagnostics).toHaveBeenCalled()
})

it('bounds the metrics window and retains the actual operation error', async () => {
  const file = metricsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 1))
  const failure = new Error('operation failed')
  await expect(measureRuntime(cwd, 'validation', async () => { throw failure })).rejects.toBe(failure)
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ stage: 'validation', outcome: 'failed' })
  expect(fs.statSync(file).size).toBeLessThan(1024)
})

it('publishes a private launch agent and refuses a destination created concurrently', () => {
  const plist = path.join(cwd, 'app.supremo.plist')
  writeLaunchAgentPlist(plist, 'first', false)
  expect(fs.statSync(plist).mode & 0o777).toBe(0o600)
  fs.unlinkSync(plist)
  const link = fs.linkSync
  vi.spyOn(fs, 'linkSync').mockImplementationOnce((...args: Parameters<typeof fs.linkSync>) => {
    fs.writeFileSync(plist, 'concurrent owner')
    return link(...args)
  })
  expect(() => writeLaunchAgentPlist(plist, 'replacement', false)).toThrow()
  expect(fs.readFileSync(plist, 'utf8')).toBe('concurrent owner')
  expect(fs.readdirSync(cwd)).toEqual(['app.supremo.plist'])
})

it('replaces only a registered plist directory entry without following a substituted symlink', () => {
  const plist = path.join(cwd, 'app.supremo.plist'), victim = path.join(cwd, 'private.txt')
  fs.writeFileSync(victim, 'preserve'); fs.symlinkSync(victim, plist)
  writeLaunchAgentPlist(plist, 'registered content', true)
  expect(fs.readFileSync(victim, 'utf8')).toBe('preserve')
  expect(fs.lstatSync(plist).isSymbolicLink()).toBe(false)
  expect(fs.readFileSync(plist, 'utf8')).toBe('registered content')
})
