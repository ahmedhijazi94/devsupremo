import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cronScaffold } from './jobs-scaffold'
const projectId='11111111-1111-4111-8111-111111111111'
let cwd:string
beforeEach(()=>{cwd=fs.mkdtempSync(path.join(os.tmpdir(),'supremo-cron-scaffold-'));fs.mkdirSync(path.join(cwd,'.supremo'));fs.writeFileSync(path.join(cwd,'.supremo/project.json'),JSON.stringify({projectId,supremoUrl:'https://supremo.example.invalid'}))})
afterEach(()=>fs.rmSync(cwd,{recursive:true,force:true}))
describe('local cron function scaffold',()=>{
 it('returns authenticated source and no signing secret, without writing application files',()=>{
   const result=cronScaffold(cwd,{slug:'daily-report'})
   expect(result).toMatchObject({path:'supabase/functions/daily-report/index.ts',implemented:false})
   expect(result.environmentName).toMatch(/^SUPREMO_CRON_[A-F0-9]{24}$/)
   expect(result.source).toContain(`Deno.env.get('${result.environmentName}')`)
   expect(result.source).toContain('crypto.subtle.verify')
   expect(result.source).toContain('status: 501')
   expect(fs.readdirSync(cwd)).toEqual(['.supremo'])
   expect(result).not.toHaveProperty('secret')
 })
 it.each([{slug:'../escape'},{slug:'https://evil.test'},{slug:'daily-report',secret:'value'},{slug:'daily-report',environment:'production'},{}])('rejects injected selectors %j',raw=>expect(()=>cronScaffold(cwd,raw)).toThrow())
 it('requires a bootstrapped UUID identity',()=>{
   fs.rmSync(path.join(cwd,'.supremo/project.json'))
   expect(()=>cronScaffold(cwd,{slug:'daily-report'})).toThrow('bootstrap')
   fs.writeFileSync(path.join(cwd,'.supremo/project.json'),JSON.stringify({projectId:'wrong',supremoUrl:'https://supremo.example.invalid'}))
   expect(()=>cronScaffold(cwd,{slug:'daily-report'})).toThrow()
 })
})
