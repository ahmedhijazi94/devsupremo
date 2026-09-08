import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { blobHash, inspectValidationIntegrity, lockEntryHash, type ValidationManifest } from '../../../packages/cli/src/validation-integrity'

it('rejects a newly nested transitive dependency that Node resolves ahead of the pinned copy',()=>{
  const cwd=mkdtempSync(path.join(tmpdir(),'supremo-tool-resolution-'))
  const original={ 'node_modules/trusted-runner':{version:'1.0.0',dependencies:{'tool-dependency':'^1.0.0'}},
    'node_modules/tool-dependency':{version:'1.0.0',integrity:'original-content'} }
  const pkg=JSON.stringify({scripts:{test:'trusted-runner'},devDependencies:{'trusted-runner':'1.0.0'}})
  const manifest:ValidationManifest={version:'test',kind:'solo',files:{},scripts:{test:'trusted-runner'},devDependencies:{'trusted-runner':'1.0.0'},lock:Object.fromEntries(Object.entries(original).map(([name,entry])=>[name,lockEntryHash(entry)]))}
  const inspect=(entries:Record<string,unknown>)=>{
    const lock=JSON.stringify({lockfileVersion:3,packages:entries})
    return inspectValidationIntegrity(manifest,[{path:'package.json',mode:'100644',sha:blobHash(pkg)},
      {path:'package-lock.json',mode:'100644',sha:blobHash(lock)}],pkg,lock)
  }
  const write=(relative:string,content:string)=>{const filename=path.join(cwd,relative);mkdirSync(path.dirname(filename),{recursive:true});writeFileSync(filename,content)}
  try {
    write('node_modules/trusted-runner/index.js',"console.log(require('tool-dependency'))")
    write('node_modules/tool-dependency/index.js',"module.exports='real-tool'")
    expect(inspect(original)).toEqual([])
    expect(execFileSync(process.execPath,['node_modules/trusted-runner/index.js'],{cwd,encoding:'utf8'}).trim()).toBe('real-tool')
    // None of the original pinned files or lock entries change.
    write('node_modules/trusted-runner/node_modules/tool-dependency/index.js',"module.exports='fake-green'")
    expect(execFileSync(process.execPath,['node_modules/trusted-runner/index.js'],{cwd,encoding:'utf8'}).trim()).toBe('fake-green')
    const nested={...original,'node_modules/trusted-runner/node_modules/tool-dependency':{version:'1.0.0',integrity:'different-content'}}
    expect(inspect(nested)).toContain('Dependência sombreia ferramenta protegida: node_modules/trusted-runner/node_modules/tool-dependency')
    expect(inspect({...original,'node_modules/new-app-library':{version:'1.0.0'}})).toEqual([])
    expect(inspect({...original,'node_modules/new-app-library/node_modules/helper':{version:'1.0.0'}})).toEqual([])
    expect(inspect({...original,'node_modules/trusted-runner/node_modules/added/node_modules/helper':{version:'1.0.0'}})).not.toEqual([])
  } finally {rmSync(cwd,{recursive:true,force:true})}
})

it('rejects an extra dependency that replaces a protected .bin command, even with npm --ignore-scripts',()=>{
  const cwd=mkdtempSync(path.join(tmpdir(),'supremo-tool-bin-'))
  const write=(relative:string,content:string)=>{const filename=path.join(cwd,relative);mkdirSync(path.dirname(filename),{recursive:true});writeFileSync(filename,content)}
  const npm=(...args:string[])=>execFileSync('npm',[...args,'--offline','--ignore-scripts','--cache',path.join(cwd,'cache'),'--no-audit','--no-fund'],{cwd,stdio:'pipe',encoding:'utf8'})
  try {
    for(const name of ['legitimate-tool','aaa-helper']) {
      write(`tools/${name}/package.json`,JSON.stringify({name,version:'1.0.0',bin:{validator:'bin.js'}}))
      write(`tools/${name}/bin.js`,`#!/usr/bin/env node\nconsole.log('${name}')\n`)
    }
    write('package.json',JSON.stringify({private:true,dependencies:{'legitimate-tool':'file:tools/legitimate-tool'}}))
    npm('install')
    const before=JSON.parse(readFileSync(path.join(cwd,'package-lock.json'),'utf8')) as {packages:Record<string,unknown>}
    const manifest:ValidationManifest={version:'test',kind:'solo',files:{},scripts:{},devDependencies:{},
      lock:Object.fromEntries(Object.entries(before.packages).filter(([name])=>name!=='').map(([name,entry])=>[name,lockEntryHash(entry)]))}
    const pkg=JSON.stringify({private:true,dependencies:{'legitimate-tool':'file:tools/legitimate-tool','aaa-helper':'file:tools/aaa-helper'}})
    write('package.json',pkg);npm('install','--package-lock-only');npm('ci')
    expect(execFileSync(process.execPath,['node_modules/.bin/validator'],{cwd,encoding:'utf8'}).trim()).toBe('aaa-helper')
    const lock=readFileSync(path.join(cwd,'package-lock.json'),'utf8')
    const errors=inspectValidationIntegrity(manifest,[{path:'package.json',mode:'100644',sha:blobHash(pkg)},
      {path:'package-lock.json',mode:'100644',sha:blobHash(lock)}],pkg,lock)
    expect(errors).toContain('Executável colide com ferramenta protegida: tools/aaa-helper')
  } finally {rmSync(cwd,{recursive:true,force:true})}
})
