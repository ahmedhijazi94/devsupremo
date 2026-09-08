import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { buildProjectFiles } from '../src/lib/templates/project-files'

const credentials = '<label>Email<input type="email"></label><label>Senha<input type="password"></label>'

async function executeLoginSmoke(html: string): Promise<{ code: number | null; requests: number; output: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-login-smoke-'))
  let requests = 0
  const server = http.createServer((_request, response) => {
    requests++
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<!doctype html><html><head><title>Login</title></head><body>${html}</body></html>`)
  })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture server unavailable')
    fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(root, 'node_modules'), 'dir')
    const spec = buildProjectFiles({ projectName: 'login-regression', description: '', kind: 'solo' }).find(file => file.path === 'e2e/smoke.spec.ts')!
    fs.writeFileSync(path.join(root, 'smoke.spec.ts'), spec.content)
    fs.writeFileSync(path.join(root, 'playwright.config.mjs'), `export default { testDir: '.', timeout: 4000, expect: { timeout: 300 }, retries: 0, workers: 1, reporter: 'line', use: { baseURL: ${JSON.stringify(`http://127.0.0.1:${address.port}`)} } }`)
    // Resolve the installed executable without invoking npm or a network install.
    const bin = fs.realpathSync(path.join(process.cwd(), 'node_modules/.bin/playwright'))
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [bin, 'test', '--grep', 'a tela de login carrega e mostra o formulário$'], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: 'true' },
      })
      let output = ''
      const killGroup = (signal: NodeJS.Signals): void => {
        if (!child.pid) return
        try { process.kill(-child.pid, signal) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      let hardKill: NodeJS.Timeout | undefined
      const timeout = setTimeout(() => {
        killGroup('SIGTERM')
        hardKill = setTimeout(() => killGroup('SIGKILL'), 1000)
      }, 10_000)
      const finish = (): void => {
        clearTimeout(timeout)
        if (hardKill) clearTimeout(hardKill)
        killGroup('SIGKILL')
      }
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.once('error', error => { finish(); reject(error) })
      child.once('exit', code => { finish(); resolve({ code, output }) })
    })
    return { ...result, requests }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
}

// Exercise the actual generated spec in a real browser. Keep this in the
// template job, which already installs browsers, rather than the unit job.
const validForms = [
  ...[
    ['Entrar na central', credentials],
    ['Acessar meus chamados', credentials],
    ['Sign in', '<label>E-mail<input type="email"></label><label>Password<input type="password"></label>'],
  ].map(([label, fields]) => `<button type="button">Entrar</button><form>${fields}<button type="button">Entrar</button><button type="submit">${label}</button></form>`),
  `<form oninput="this.querySelector('button').disabled = !Array.from(this.querySelectorAll('input')).every(input => input.value.length > 0)">${credentials}<button type="submit" disabled>Entrar</button></form>`,
  `<form style="display:none">${credentials}<button type="submit">Criar conta</button></form><form>${credentials}<button type="submit">Entrar</button></form>`,
]
for (const html of validForms) {
  const result = await executeLoginSmoke(html)
  assert.equal(result.code, 0, result.output)
  assert.ok(result.requests > 0, 'Generated smoke must visit the actual page')
  assert.match(result.output, /1 passed/)
}
const invalidForms = [
  ['missing submit', `<form>${credentials}<button type="button">Entrar</button></form>`, 'toHaveCount'],
  ['submit outside the form', `<form>${credentials}</form><button type="submit">Entrar</button>`, 'toHaveCount'],
  ['disabled submit', `<form>${credentials}<button type="submit" disabled>Entrar</button></form>`, 'toBeEnabled'],
  ['credentials split between forms', '<form><label>Email<input type="email"></label><button type="submit">Entrar</button></form><form><label>Senha<input type="password"></label><button type="submit">Entrar</button></form>', 'toHaveCount'],
  ['credentials without accessible names', '<form><input type="email"><input type="password"><button type="submit">Entrar</button></form>', 'toHaveAccessibleName'],
  ['readonly credentials', `<form>${credentials.replace('type="email"', 'type="email" readonly')}<button type="submit">Entrar</button></form>`, 'toBeEditable'],
  ['disabled credentials', `<form>${credentials.replace('type="password"', 'type="password" disabled')}<button type="submit">Entrar</button></form>`, 'toBeEditable'],
] as const
for (const [name, html, matcher] of invalidForms) {
  const result = await executeLoginSmoke(html!)
  assert.notEqual(result.code, 0, `${name}: ${result.output}`)
  assert.ok(result.requests > 0, `${name}: generated smoke must visit the actual page`)
  assert.match(result.output, /1 failed/)
  assert.ok(result.output.includes(`Error: expect(locator).${matcher}`), `${name}: must fail at ${matcher}, not a crash: ${result.output}`)
}
console.log(`Generated login smoke: ${validForms.length} valid forms accepted; ${invalidForms.length} invalid forms rejected in Chromium.`)
