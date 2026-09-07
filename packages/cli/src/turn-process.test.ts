import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { buildSync } from 'esbuild'
import { expect, it } from 'vitest'
import type { BackendTurnContext } from '../../../src/lib/checkpoint/turn-context'
import { defaultCheckpointDeps } from './checkpoint'
import type { TurnResult } from './turn-runtime'
import { gitText, readJson, writeJson } from './turn-workspace'

const execute = promisify(execFile)
const PROJECT = '11111111-1111-4111-8111-111111111111'
const prompts = [
  'Crie uma Central de Chamados para uma pequena equipe. Quero login e que cada usuário veja apenas os próprios chamados. Cada chamado deve ter título, descrição, prioridade e status. Quero criar, editar e excluir. Faça uma interface bonita e responsiva.',
  'Adicione busca por título, filtro por status, contadores e paginação. Melhore também a experiência no celular.',
  'Mostre a data e a hora de criação em cada chamado.',
]

/** Actual domain assertions; no keyword-based success and no validator stub returning green. */
const behaviorTests = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visible, search } from '../tickets.mjs';
test('unit: each user sees only their tickets', () => {
  const rows = [{ userId: 'A', title: 'Login' }, { userId: 'B', title: 'Pagamento' }];
  assert.deepEqual(visible(rows, 'B'), [rows[1]]);
});
test('unit: search is case insensitive and preserves ownership', () => {
  const rows = [{ userId: 'A', title: 'Login' }, { userId: 'B', title: 'Login' }];
  assert.equal(search(visible(rows, 'A'), 'LOGIN').length, 1);
});
`
const verify = `import fs from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
const test = spawnSync(process.execPath, ['--test', 'tests/tickets.test.mjs'], { encoding: 'utf8' });
process.stdout.write(test.stdout); process.stderr.write(test.stderr);
const status = test.status === 0 ? 'passed' : 'failed';
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding:'utf8' }).trim();
const base = process.argv[process.argv.indexOf('--base') + 1];
fs.mkdirSync('.supremo', {recursive:true});
fs.writeFileSync('.supremo/verify-result.json', JSON.stringify({sha,base,status,checks:[{name:'unit',status}]}));
process.exit(status === 'passed' ? 0 : 1);
`

it('cold start processes reconcile remote failure, revalidate repair and preserve the next feature', async () => {
  // Host/model and backend are controlled fixture boundaries. Git, HTTP transport,
  // lifecycle persistence, OS processes, validator and behavior assertions are real.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-process-'))
  const root = path.join(parent, 'project')
  fs.mkdirSync(root)
  const backendFile = path.join(parent, 'backend.json')
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(request.url === '/preview' ? '{"healthy":true}' : fs.readFileSync(backendFile))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing local HTTP address')
  const origin = `http://127.0.0.1:${address.port}`
  try {
    gitText(root, ['init', '-b', 'main'])
    gitText(root, ['config', 'user.name', 'Supremo Harness'])
    gitText(root, ['config', 'user.email', 'harness@example.invalid'])
    gitText(root, ['remote', 'add', 'origin', 'https://github.com/fixture/tickets.git'])
    fs.mkdirSync(path.join(root, '.supremo'))
    fs.mkdirSync(path.join(root, 'scripts'))
    fs.mkdirSync(path.join(root, 'tests'))
    fs.writeFileSync(path.join(root, '.gitignore'), '.supremo/turns/\n.supremo/validation/\n.supremo/checkpoints/\n.supremo/turn-context.json\n.supremo/validation-feedback.json\n')
    writeJson(path.join(root, '.supremo/project.json'), {projectId: PROJECT, supremoUrl: origin})
    fs.writeFileSync(path.join(root, 'scripts/verify.mjs'), verify)
    fs.writeFileSync(path.join(root, 'tests/tickets.test.mjs'), behaviorTests)
    const implementation = (broken = false, date = false): void => fs.writeFileSync(path.join(root, 'tickets.mjs'),
      `export const visible = (rows, userId) => rows.filter(row => row.userId === userId);\n` +
      `export const search = (rows, q) => rows.filter(row => row.title${broken ? '' : '.toLowerCase()'}.includes(q${broken ? '' : '.toLowerCase()'}));\n` +
      (date ? `export const createdAt = row => new Date(row.createdAt).toISOString();\n` : ''))
    implementation()
    gitText(root, ['add', '-A']); gitText(root, ['commit', '-m', 'Initial fixture'])
    const initialHead = gitText(root, ['rev-parse', 'HEAD'])
    const backend: BackendTurnContext = {version:1,projectId:PROJECT,project:{id:PROJECT,name:'Central de Chamados'},
      repository:{fullName:'fixture/tickets',url:'https://github.com/fixture/tickets.git',branch:'main',defaultBranch:'main'},
      environment:'development',databaseEnvironment:'development',databaseAuthority:{projectRef:'fixture',source:'supremo_provisioned',automaticMigrations:true},
      latestCheckpoint:null,feedback:{current:null,previousFailure:null},observedAt:new Date().toISOString()}
    writeJson(backendFile, backend)
    const entry = path.join(parent, 'driver.ts')
    const driver = path.join(parent, 'driver.cjs')
    fs.writeFileSync(entry, `import {runTurnEvent} from ${JSON.stringify(path.join(__dirname, 'turn-runtime'))};
import {drainLocalValidation} from ${JSON.stringify(path.join(__dirname, 'turn-validation'))};
import {readFileSync} from 'node:fs';
async function main() {
  const [root, origin, event] = process.argv.slice(2);
  if(event === 'worker') { console.log(JSON.stringify({drained:await drainLocalValidation(root)})); return; }
  const input = JSON.parse(readFileSync(0,'utf8'));
  const health = await fetch(origin+'/preview').then(r=>r.json());
  const result = await runTurnEvent(event, root, input, 'codex', {
    reconcile: async () => fetch(origin+'/turn-context').then(r=>r.json()),
    now:()=>new Date().toISOString(),
    ensureServices:()=>({preview:{healthy:health.healthy,url:origin+'/preview'},daemon:{running:true}})
  });
  console.log(JSON.stringify(result));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});`)
    buildSync({entryPoints:[entry],outfile:driver,bundle:true,platform:'node',target:'node18',logLevel:'silent'})
    const call = async (event: string, input: object = {}): Promise<TurnResult> => {
      const child = execFile(process.execPath, [driver, root, origin, event], {encoding:'utf8',timeout:20_000,maxBuffer:2*1024*1024})
      child.stdin?.end(JSON.stringify(input))
      const output = await new Promise<string>((resolve,reject) => {
        let stdout = '', stderr = ''
        child.stdout?.on('data', (chunk: string) => { stdout += chunk })
        child.stderr?.on('data', (chunk: string) => { stderr += chunk })
        child.once('error', reject)
        child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)))
      })
      return JSON.parse(output) as TurnResult
    }
    for (let turn=0;turn<2;turn++) {
      const preflight = await call('preflight',{prompt:prompts[turn],session_id:`session-${turn}`,hook_event_name:'UserPromptSubmit'})
      expect(preflight.allowed).toBe(true)
      if (turn === 0) fs.writeFileSync(path.join(root, 'description.txt'), 'Central de Chamados\n')
      else implementation(true)
      expect((await call('complete')).allowed).toBe(true)
    }
    const queue = (): ReturnType<ReturnType<typeof defaultCheckpointDeps>['readQueue']> => defaultCheckpointDeps(root).readQueue()
    expect(queue()).toHaveLength(2)
    expect(queue().every(item=>item.validationStatus==='pending')).toBe(true)
    const failed = queue().at(-1)!
    // Controlled remote validation really executes the regression, then persists its evidence.
    expect(() => execFileSync(process.execPath,['--test','tests/tickets.test.mjs'],{cwd:root,stdio:'pipe'})).toThrow()
    const observedAt = new Date().toISOString()
    backend.latestCheckpoint = {id:failed.checkpointId,localSha:failed.commitSha,publishedSha:'b'.repeat(40),pushStatus:'published',integrationStatus:'ci_failed',integrationBranch:'supremo/integration',createdAt:failed.createdAt}
    backend.feedback.current = {projectId:PROJECT,checkpointId:failed.checkpointId,commitSha:failed.commitSha,publishedSha:'b'.repeat(40),observedAt,state:'failed',failures:[{name:'unit',category:'code'}],summary:'Search case-insensitivity regression',evidence:'Expected 1 result for LOGIN; received 0'}
    writeJson(backendFile,backend)
    writeJson(path.join(root,'.supremo/validation-feedback.json'),{current:null,previousFailure:null})
    const cold = await call('preflight',{prompt:prompts[2],session_id:'brand-new-process',hook_event_name:'UserPromptSubmit'})
    expect(cold.state?.turn.phase).toBe('recovery')
    expect(cold.state?.turn.recovery?.checkpointId).toBe(failed.checkpointId)
    expect((await call('complete')).allowed).toBe(false)
    implementation(false)
    await call('repair-complete')
    // Each worker invocation is a new process, reading its predecessor's durable queue.
    while (queue().some(item=>item.validationStatus==='pending')) await call('worker')
    expect((await call('status')).state?.turn.recovery?.status).toBe('resolved')
    implementation(false,true)
    expect((await call('complete')).allowed).toBe(true)
    await call('worker')
    expect(queue().at(-1)?.validationStatus).toBe('passed')
    expect(gitText(root,['rev-parse','HEAD'])).toBe(initialHead)
    expect((readJson(path.join(root,'.supremo/turns/state.json')) as {turn:{status:string}}).turn.status).toBe('completed')
    expect((await execute(process.execPath,['--input-type=module','-e',"import {createdAt} from './tickets.mjs'; if(createdAt({createdAt:'2026-09-06T12:00:00Z'}) !== '2026-09-06T12:00:00.000Z') process.exit(1)"],{cwd:root})).stderr).toBe('')
    expect((await fetch(origin+'/preview')).ok).toBe(true)
  } finally {
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))
    fs.rmSync(parent,{recursive:true,force:true})
  }
},60_000)
