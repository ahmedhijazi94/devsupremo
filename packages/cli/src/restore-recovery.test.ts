import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCheckpointRecord, defaultCheckpointDeps } from './checkpoint'
import { applyRestore, defaultRestoreDeps } from './restore'
import { readRestoreReceipts, recoverRestoreReceipt, writeRestoreReceipt, type RestoreReceipt } from './restore-outbox'

const folders: string[] = []
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const root = path.resolve(import.meta.dirname, '../../..')
function setup() {
  const cwd = mkdtempSync(path.join(tmpdir(),'supremo-restore-recovery-')); folders.push(cwd)
  const git = (...args: string[]) => execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
  git('init','-q'); git('config','user.name','Restore Test'); git('config','user.email','restore@example.test')
  writeFileSync(path.join(cwd,'.gitignore'),'.supremo/\n')
  writeFileSync(path.join(cwd,'app.txt'),'blue\n'); git('add','.'); git('commit','-qm','A')
  const a = git('rev-parse','HEAD')
  writeFileSync(path.join(cwd,'app.txt'),'green\n'); git('add','.'); git('commit','-qm','B')
  const b = git('rev-parse','HEAD')
  const base = defaultCheckpointDeps(cwd)
  for (const [checkpointId,commitSha,parentCheckpointId] of [[id(1),a,null],[id(2),b,id(1)]] as const) {
    base.appendQueue({ ...buildCheckpointRecord({ checkpointId,commitSha,parentCheckpointId,projectId:id(10),createdAt:new Date().toISOString(),summary:'App',changedPaths:['app.txt'] }),pushStatus:'published',environment:'development' })
  }
  return {cwd,git,base,deps:defaultRestoreDeps(base,cwd)}
}
afterEach(()=>{for(const folder of folders.splice(0))rmSync(folder,{recursive:true,force:true})})

describe('restore recovery with real Git and durable receipts',()=>{
  it('lost ACK followed by a new OS process does not apply or commit the restore twice',()=>{
    const {cwd,git,base}=setup()
    const runner = path.join(cwd,'runner.mts')
    // Keep the runner outside the worktree so it is not part of a safeguard.
    const scriptDir=mkdtempSync(path.join(tmpdir(),'supremo-restore-runner-'));folders.push(scriptDir)
    const script=path.join(scriptDir,path.basename(runner))
    writeFileSync(script,`
import { processRestores, NetworkError } from ${JSON.stringify(path.join(root,'packages/cli/src/daemon.ts'))};
const [cwd, phase] = process.argv.slice(2);
const reports=[];
const req={restoreRequestId:${JSON.stringify(id(3))},targetCheckpointId:${JSON.stringify(id(1))},targetSummary:'App',claimToken:${JSON.stringify(id(4))},leaseExpiresAt:new Date(Date.now()+600000).toISOString(),environment:'development'};
await processRestores({cwd,projectId:${JSON.stringify(id(10))},apiBaseUrl:'https://example.test',getSecret:()=> 'local-device-placeholder'},{http:{
publish:async()=>{throw new Error('unexpected publication')},syncStatus:async()=>({latest:null}),pollRestores:async()=>phase==='first'?[req]:[],
reportRestoreApplied:async r=>{reports.push(r);if(phase==='first')throw new NetworkError('offline')},reportRestoreFailed:async()=>{throw new Error('unexpected failure')}
}});
console.log(JSON.stringify(reports));
`)
    const run=(phase:string)=>{
      const result=spawnSync(process.execPath,['--import','tsx',script,cwd,phase],{cwd:root,encoding:'utf8',timeout:30000})
      expect(result.stderr).toBe('');expect(result.status).toBe(0)
      return JSON.parse(result.stdout) as Array<{resultCheckpointId:string;resultCommitSha:string}>
    }
    const first=run('first')
    expect(readFileSync(path.join(cwd,'app.txt'),'utf8')).toBe('blue\n')
    const head=git('rev-parse','HEAD')
    expect(git('rev-list','--count','HEAD')).toBe('3')
    expect(readRestoreReceipts(cwd,id(10))[0]?.acknowledged).toBe(false)
    const second=run('restart')
    expect(second[0]?.resultCheckpointId).toBe(first[0]?.resultCheckpointId)
    expect(git('rev-parse','HEAD')).toBe(head)
    expect(git('rev-list','--count','HEAD')).toBe('3')
    expect(base.readQueue()).toHaveLength(3)
    expect(readRestoreReceipts(cwd,id(10))[0]?.acknowledged).toBe(true)
  })
  it('recovers the exact restore commit after a crash before queue append',()=>{
    const {cwd,deps,base,git}=setup()
    const receipt:RestoreReceipt={projectId:id(10),requestId:id(3),claimToken:id(4),targetCheckpointId:id(1),resultCheckpointId:id(5),status:'applying',resultCommitSha:null,error:null,acknowledged:false}
    writeRestoreReceipt(cwd,receipt)
    expect(()=>applyRestore(id(1),'App',id(10),{...deps,appendQueue:()=>{throw new Error('process died')}},
      {resultCheckpointId:id(5),requestId:id(3),environment:'development'})).toThrow('process died')
    expect(base.readQueue()).toHaveLength(2)
    const recovered=recoverRestoreReceipt(readRestoreReceipts(cwd,id(10))[0]!,deps)
    expect(recovered.status).toBe('applied')
    expect(recovered.resultCommitSha).toBe(git('rev-parse','HEAD'))
    expect(base.readQueue().at(-1)?.checkpointId).toBe(id(5))
    expect(git('rev-list','--count','HEAD')).toBe('3')
  })
  it('does not append an older restore snapshot after subsequent work advanced HEAD',()=>{
    const {cwd,deps,base,git}=setup()
    const receipt:RestoreReceipt={projectId:id(10),requestId:id(3),claimToken:id(4),targetCheckpointId:id(1),resultCheckpointId:id(5),status:'applying',resultCommitSha:null,error:null,acknowledged:false}
    expect(()=>applyRestore(id(1),'App',id(10),{...deps,appendQueue:()=>{throw new Error('crash')}},
      {resultCheckpointId:id(5),requestId:id(3),environment:'development'})).toThrow()
    writeFileSync(path.join(cwd,'app.txt'),'new work\n');git('add','.');git('commit','-qm','new work')
    expect(recoverRestoreReceipt(receipt,deps).status).toBe('failed')
    expect(base.readQueue()).toHaveLength(2)
    expect(readFileSync(path.join(cwd,'app.txt'),'utf8')).toBe('new work\n')
  })
})
