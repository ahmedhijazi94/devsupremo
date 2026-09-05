#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inventory, missingProofs } from './rls-isolation-inventory.mjs'
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const root = path.resolve(__dirname, '..')
const temp = mkdtempSync(path.join(tmpdir(), 'supremo-isolation-'))
try {
  const required = inventory(root)
  const report = path.join(temp, 'proofs.json')
  const result = spawnSync(process.execPath, [
    path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'rls.test',
    '--reporter=default', '--reporter=' + path.join(__dirname, 'rls-isolation-reporter.mjs'),
  ], { cwd: root, stdio: 'inherit', env: { ...process.env, SUPREMO_ISOLATION_REPORT: report } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('A suíte RLS falhou ou foi interrompida.')
  const evidence = JSON.parse(readFileSync(report, 'utf8'))
  if (!Array.isArray(evidence.passed) || evidence.errors !== 0) throw new Error('Relatório de isolamento inválido.')
  const missing = missingProofs(required, evidence.passed)
  if (missing.length) throw new Error('Falta prova executável de isolamento cruzado:\n' + missing.map((t) => `- ${t.name} (${t.file}): adicione isolationTest em um arquivo *.rls.test.ts, com fixture válida e dois usuários distintos.`).join('\n'))
  console.log(`✓ Isolamento executado para ${required.length} tabela(s) protegida(s).`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  rmSync(temp, { recursive: true, force: true })
}
