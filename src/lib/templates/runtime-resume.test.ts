import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { harnessFiles, supremoStatusScript } from './harness'

let cwd: string
const statePath = (): string => path.join(cwd, '.supremo/fixture-preview.json')
const logPath = (): string => path.join(cwd, '.supremo/wrapper-calls.jsonl')
const healthy = { running: true, healthy: true, url: 'http://127.0.0.1:3071', pid: 12345, port: 3071, instance: 'preserved' }

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-runtime-resume-'))
  for (const directory of ['scripts', 'tools/supremo-cli/dist', '.supremo/checkpoints']) fs.mkdirSync(path.join(cwd, directory), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'scripts/supremo-status.mjs'), harnessFiles('tanstack-start-vite')['scripts/supremo-status.mjs']!)
  // The parent test process is alive; this fixture must not start a daemon.
  fs.writeFileSync(path.join(cwd, '.supremo/checkpoints/daemon.pid'), String(process.pid))
  fs.writeFileSync(path.join(cwd, 'scripts/preview.mjs'), "import fs from 'node:fs'; fs.writeFileSync('.supremo/direct-supervisor-called', 'unexpected'); throw new Error('runtime wrapper bypassed')")
  // Exercise the generated script as a real child process, with a bounded local
  // wrapper fixture. No dependency install, network, listener or preview starts.
  fs.writeFileSync(path.join(cwd, 'tools/supremo-cli/dist/bin.js'), `
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync('.supremo/wrapper-calls.jsonl', JSON.stringify(args) + '\\n')
if (args.length !== 2 || args[0] !== 'runtime-preview' || !['status', 'ensure'].includes(args[1])) process.exit(9)
if (args[1] === 'ensure') fs.writeFileSync('.supremo/fixture-preview.json', JSON.stringify(${JSON.stringify(healthy)}))
const state = fs.existsSync('.supremo/fixture-preview.json') ? JSON.parse(fs.readFileSync('.supremo/fixture-preview.json', 'utf8')) : { running: false, healthy: false }
process.stdout.write(JSON.stringify(state))
`)
})
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }) })

function calls(): string[][] {
  return fs.readFileSync(logPath(), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
}

function invoke(args: string[]): { preview: { healthy: boolean; url: string | null }; daemon: { healthy: boolean } } {
  const result = execFileSync(process.execPath, ['scripts/supremo-status.mjs', ...args], {
    cwd, encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
      SUPREMO_PREFLIGHT_POLL_INTERVAL_MS: '10', SUPREMO_PREFLIGHT_POLL_TIMEOUT_MS: '100' },
  })
  return JSON.parse(result) as { preview: { healthy: boolean; url: string | null }; daemon: { healthy: boolean } }
}

describe('Start resume uses the prepared runtime boundary', () => {
  it('routes status through the bundled wrapper without trying to repair a missing preview', () => {
    expect(invoke([]).preview.healthy).toBe(false)
    expect(calls()).toEqual([['runtime-preview', 'status']])
    expect(fs.existsSync(statePath())).toBe(false)
    expect(fs.existsSync(path.join(cwd, '.supremo/direct-supervisor-called'))).toBe(false)
  })

  it('routes an unhealthy preview ensure and subsequent status through the wrapper', () => {
    const result = invoke(['--ensure'])
    expect(result.preview).toMatchObject({ healthy: true, url: healthy.url })
    expect(result.daemon.healthy).toBe(true)
    expect(calls()).toEqual([['runtime-preview', 'status'], ['runtime-preview', 'ensure'], ['runtime-preview', 'status']])
    expect(fs.existsSync(path.join(cwd, '.supremo/direct-supervisor-called'))).toBe(false)
  })

  it('preserves a healthy preview state without calling ensure', () => {
    const original = JSON.stringify(healthy)
    fs.writeFileSync(statePath(), original)
    expect(invoke(['--ensure']).preview.healthy).toBe(true)
    expect(calls()).toEqual([['runtime-preview', 'status']])
    expect(fs.readFileSync(statePath(), 'utf8')).toBe(original)
  })

  it('retains the legacy Next invocation and passes the framework through harness generation', () => {
    expect(supremoStatusScript()).toBe(supremoStatusScript('nextjs'))
    expect(supremoStatusScript()).toContain("tryJson('node', ['scripts/preview.mjs', 'status'])")
    expect(supremoStatusScript()).toContain("run('node', ['scripts/preview.mjs', 'ensure'])")
    const start = harnessFiles('tanstack-start-vite')['scripts/supremo-status.mjs']!
    expect(start).not.toContain("['scripts/preview.mjs',")
    expect(start).toContain("['tools/supremo-cli/dist/bin.js', 'runtime-preview', 'status']")
  })
})
