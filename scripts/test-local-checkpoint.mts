/** Testa scripts REAIS do app gerado em um diretório descartável. Sem provedores remotos. */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { parseQueue, QUEUE_FILE } from '../packages/cli/src/checkpoint'
const cwd = fs.realpathSync(process.argv[2] ?? '')
if (!cwd.startsWith('/private/tmp/supremo-') && !cwd.startsWith('/tmp/supremo-')) throw new Error('Use app descartável supremo-* em /tmp.')
if (fs.existsSync(path.join(cwd, '.git'))) throw new Error('O teste exige um diretório ainda sem histórico Git.')
const run = (bin: string, args: string[]) => execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:9' } })
run('git', ['init'])
run('git', ['config', 'user.name', 'Supremo QA'])
run('git', ['config', 'user.email', 'qa@example.test'])
const metadata = path.join(cwd, '.supremo/project.json')
fs.writeFileSync(metadata, JSON.stringify({ ...JSON.parse(fs.readFileSync(metadata, 'utf8')), projectId: '00000000-0000-0000-0000-000000000001' }))
run('git', ['add', '.'])
run('git', ['commit', '-m', 'initial test app'])
fs.writeFileSync(path.join(cwd, 'checkpoint-qa.txt'), 'alteração local de teste\n')
const started = performance.now()
run('npm', ['run', 'checkpoint', '--', 'Checkpoint de teste offline'])
const elapsed = performance.now() - started
const journal = fs.readFileSync(path.join(cwd, QUEUE_FILE), 'utf8')
assert.equal(parseQueue(journal).length, 1)
assert.equal(run('git', ['status', '--porcelain']).trim(), '')
console.log(`✓ Checkpoint real criado sem rede em ${Math.round(elapsed)} ms; fila preservada e árvore limpa.`)
