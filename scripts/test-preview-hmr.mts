/** Real HMR on a disposable generated app; restores the source in finally. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from '@playwright/test'

const root = fs.realpathSync(process.argv[2] ?? '')
if (!/^\/(?:private\/)?tmp\/supremo-[^/]+$/.test(root)) throw new Error('Use um scaffold descartável supremo-* em /tmp.')
const status = (): { pid: number; url: string; healthy: boolean } => JSON.parse(execFileSync(process.execPath,
  ['scripts/preview.mjs', 'status'], { cwd: root, encoding: 'utf8' })) as { pid: number; url: string; healthy: boolean }
const before = status()
assert.equal(before.healthy, true)
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(before.url).hostname))
const file = path.join(root, 'app/design-system/examples.tsx')
const original = fs.readFileSync(file, 'utf8')
const marker = 'Prévia atualizada pelo HMR'
const changed = original.replace('>Visão geral</h1>', `>${marker}</h1>`)
assert.notEqual(changed, original)
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.goto(`${before.url}/design-system`)
  await page.getByRole('heading', { name: 'Visão geral', exact: true }).waitFor()
  await page.getByLabel('Nome', { exact: false }).fill('Estado preservado')
  const started = performance.now()
  fs.writeFileSync(file, changed)
  await page.getByRole('heading', { name: marker, exact: true }).waitFor({ timeout: 20_000 })
  const elapsed = Math.round(performance.now() - started)
  assert.equal(await page.getByLabel('Nome', { exact: false }).inputValue(), 'Estado preservado')
  const after = status()
  assert.equal(after.pid, before.pid)
  assert.equal(after.url, before.url)
  assert.equal(after.healthy, true)
  console.log(`✓ HMR real em ${elapsed} ms, estado do formulário preservado, mesmo processo e mesma URL. Medição local única.`)
} finally {
  fs.writeFileSync(file, original)
  await browser.close()
}
