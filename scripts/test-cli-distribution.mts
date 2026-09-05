/** Prova que npm instala/executa a CLI por HTTP sem acessar um registry. */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { cliArtifact } from '../src/lib/bootstrap/cli-artifact'
import pkg from '../packages/cli/package.json'
const artifact = cliArtifact()
const cache = mkdtempSync(join(tmpdir(), 'supremo-distribution-'))
const server = createServer((req, res) => {
  if (req.url !== `/${artifact.digest}.tgz`) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'content-type': 'application/gzip' }).end(artifact.bytes)
})
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Porta ausente')
  const url = `http://127.0.0.1:${address.port}/${artifact.digest}.tgz`
  const child = spawn('npm', ['exec', '--yes', '--cache', cache, '--registry', 'http://127.0.0.1:9', '--package', url, '--', 'supremo', '--version'], {
    cwd: cache, env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' },
  })
  let output = '', error = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString() })
  const timeout = setTimeout(() => child.kill('SIGTERM'), 30000)
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  clearTimeout(timeout)
  assert.equal(code, 0, error)
  assert.equal(output.trim(), pkg.version)
  console.log(`✓ CLI ${pkg.version} instalada por HTTP e executada sem registry; pacote identificado pelo hash.`)
} finally {
  server.closeAllConnections()
  server.close()
  rmSync(cache, { recursive: true, force: true })
}
