import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { backgroundRecoveryAvailable } from './background-recovery'
import { writeJson } from './turn-workspace'

let cwd: string
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-worker-authority-'))
  fs.mkdirSync(path.join(cwd, 'tools/supremo-cli/dist'), { recursive: true }); fs.mkdirSync(path.join(cwd, 'node_modules'))
  fs.writeFileSync(path.join(cwd, 'tools/supremo-cli/package.json'), JSON.stringify({ name: 'supremo-cli', version: '1.13.0' }))
  fs.writeFileSync(path.join(cwd, 'tools/supremo-cli/dist/bin.js'), 'code')
  fs.symlinkSync(path.join(cwd, 'tools/supremo-cli'), path.join(cwd, 'node_modules/supremo-cli'))
  fs.writeFileSync(path.join(cwd, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  vi.stubEnv('PATH', cwd)
  writeJson(path.join(cwd, '.supremo/checkpoints/runtime.json'), { version: '1.13.0', digest: crypto.createHash('sha256').update('code').digest('hex'),
    pid: process.pid, startedAt: Date.now(), protocolVersion: 1, queueProtocol: 2 })
  fs.writeFileSync(path.join(cwd, '.supremo/checkpoints/daemon.pid'), String(process.pid))
  writeJson(path.join(cwd, '.supremo/validation/worker-health.json'), { protocolVersion: 1, pid: process.pid, checkedAt: Date.now() })
})
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(cwd, { recursive: true, force: true }) })
it('requires explicit repair policy, current worker and matching running version independently', () => {
  expect(backgroundRecoveryAvailable(cwd, 'codex')).toBe(false)
  writeJson(path.join(cwd, '.supremo/lifecycle.json'), { auto_heal: { enabled: true, runner: 'codex' } })
  expect(backgroundRecoveryAvailable(cwd, 'codex')).toBe(true)
  writeJson(path.join(cwd, '.supremo/lifecycle.json'), { auto_heal: { enabled: true } })
  expect(backgroundRecoveryAvailable(cwd, 'codex')).toBe(false)
  writeJson(path.join(cwd, '.supremo/lifecycle.json'), { auto_heal: { enabled: true, runner: 'codex' } })
  writeJson(path.join(cwd, '.supremo/validation/worker-health.json'), { protocolVersion: 1, pid: process.pid, checkedAt: Date.now() - 30_000 })
  expect(backgroundRecoveryAvailable(cwd, 'codex')).toBe(false)
  writeJson(path.join(cwd, '.supremo/validation/worker-health.json'), { protocolVersion: 1, pid: process.pid, checkedAt: Date.now() })
  fs.writeFileSync(path.join(cwd, 'tools/supremo-cli/dist/bin.js'), 'new version, old process')
  expect(backgroundRecoveryAvailable(cwd, 'codex')).toBe(false)
})
