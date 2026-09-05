import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { describe, expect, it } from 'vitest'
import { isolationGateFiles } from './isolation-gate'
import { buildProjectFiles } from './project-files'

interface Table { name: string; file: string }
const inventoryModule = '../../../scripts/rls-isolation-inventory.mjs'
const { protectedTables, missingProofs } = await import(inventoryModule) as {
  protectedTables(migrations: Array<{ file: string; source: string }>): Table[]
  missingProofs(tables: Table[], proofs: string[]): Table[]
}
const inventory = (...sql: string[]): Table[] => protectedTables(sql.map((source, i) => ({ file: `${i}.sql`, source })))

describe('inventário genérico de provas de isolamento', () => {
  it('nova tabela em migration posterior não herda a prova de outra tabela', () => {
    const tables = inventory('create table profiles (id uuid references auth.users(id));',
      'create table feedback (id uuid, owner_id uuid); alter table feedback enable row level security;')
    expect(missingProofs(tables, ['public.profiles']).map((t) => t.name)).toEqual(['public.feedback'])
  })
  it('detecta identificadores qualificados/aspados, FK de nome arbitrário e ALTER posterior', () => {
    expect(inventory('CREATE TABLE "private"."Messages" (id uuid, "author" uuid REFERENCES "auth"."users"(id));',
      'CREATE TABLE notes (id uuid);', 'ALTER TABLE notes ADD COLUMN owner_id uuid;').map((t) => t.name))
      .toEqual(['private.Messages', 'public.notes'])
  })
  it('detecta tenant, dependência de ownership e policy com função customizada', () => {
    const sql = `create table teams(id uuid); create policy access on teams using (is_member(id));
      create table documents(id uuid, team_id uuid references teams(id));
      create table attachments(id uuid, document uuid references documents(id));`
    expect(inventory(sql).map((t) => t.name)).toEqual(['public.attachments', 'public.documents', 'public.teams'])
  })
  it('ignora comentários/literais/corpos de função e tabela pública sem ownership', () => {
    expect(inventory(`-- create table fake(user_id uuid);
      /* outer /* create table fake2(owner_id uuid); */ */
      create table catalogue(id uuid, label text default 'owner_id; create table fake3(user_id uuid)');
      create function doc() returns text language sql as $$select 'create table fake4(user_id uuid)'$$;
      create policy read on catalogue for select using (true);`)).toEqual([])
  })
  it('mantém tabelas homônimas separadas por schema e considera DROP', () => {
    const tables = inventory('create table private.notes(owner_id uuid); create table public.notes(user_id uuid);', 'drop table public.notes;')
    expect(missingProofs(tables, ['public.notes']).map((t) => t.name)).toEqual(['private.notes'])
  })
  it('acompanha renomeação e não aceita DDL não reconhecido como inventário vazio', () => {
    expect(inventory('create unlogged table notes(owner_id uuid); alter table notes rename to entries;').map((t) => t.name)).toEqual(['public.entries'])
    expect(() => inventory('create table notes as select * from private_notes;')).toThrow('não reconhecido')
    expect(() => inventory('create table notes (like private_notes including all);')).toThrow('herdada/derivada')
  })
  it.each(['solo', 'team', 'public'] as const)('scaffold %s tem helper por tabela inicial detectada', (kind) => {
    const files = buildProjectFiles({ projectName: 'fixture', description: '', kind })
    const tables = protectedTables(files.filter((f) => f.path.startsWith('supabase/migrations/')).map((f) => ({ file: f.path, source: f.content })))
    const tests = files.filter((f) => f.path.endsWith('.rls.test.ts')).map((f) => f.content).join('\n')
    for (const table of tables) expect(tests).toContain(`isolationTest('${table.name}'`)
    const ci = files.find((f) => f.path === '.github/workflows/ci.yml')!.content
    expect(ci).toContain('    needs: rls')
    expect(ci).toContain('    if: ${{ always() }}')
    expect(ci).toContain("if: needs.rls.result != 'success'")
    expect(ci).toContain("'**/*.rls.test.ts'")
    expect(ci).toContain("'scripts/rls-isolation-*'")
  })
})

type Scenario = 'public' | 'pass' | 'missing' | 'skip' | 'todo' | 'empty' | 'excluded' | 'same-user' | 'no-row' | 'leak' | 'write-leak' | 'delete-leak' | 'network-error' | 'partial'
async function executeGate(scenario: Scenario): Promise<{ code: number | null; output: string; requests: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'isolation-gate-test-'))
  let requests = 0
  const userA = '00000000-0000-0000-0000-000000000001'
  const userB = '00000000-0000-0000-0000-000000000002'
  const server = http.createServer((req, res) => {
    requests++
    const foreign = req.headers.authorization === 'Bearer other-token'
    res.setHeader('Content-Type', 'application/json')
    if (req.url?.startsWith('/auth/v1/user')) {
      res.end(JSON.stringify({ id: foreign && scenario !== 'same-user' ? userB : userA, aud: 'authenticated', role: 'authenticated' })); return
    }
    if (scenario === 'network-error') { res.statusCode = 500; res.end(JSON.stringify({ code: 'XX000', message: 'database unavailable' })); return }
    const visible = scenario !== 'no-row' && (!foreign || scenario === 'leak'
      || (scenario === 'write-leak' && req.method === 'PATCH') || (scenario === 'delete-leak' && req.method === 'DELETE'))
    res.end(JSON.stringify(visible ? [{ id: 'row-a' }] : []))
  })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address')
    symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir')
    for (const file of isolationGateFiles()) {
      mkdirSync(join(dir, file.path, '..'), { recursive: true })
      writeFileSync(join(dir, file.path), file.content)
    }
    mkdirSync(join(dir, 'supabase/migrations'), { recursive: true })
    writeFileSync(join(dir, 'supabase/migrations/001.sql'), scenario === 'public'
      ? 'create table feedback(id uuid, name text, message text); alter table feedback enable row level security; create policy submit on feedback for insert to anon with check (true);'
      : 'create table feedback(id uuid, user_id uuid); alter table feedback enable row level security;')
    writeFileSync(join(dir, 'package.json'), '{"private":true}')
    writeFileSync(join(dir, 'vitest.config.mjs'), `export default { test: { environment: 'node', include: ['supabase/*.rls.test.ts'], ${scenario === 'excluded' ? "exclude: ['supabase/proof.rls.test.ts']," : ''} maxWorkers: 1, fileParallelism: false } }`)
    const body = "isolationTest('public.feedback', async () => ({ rowId: 'row-a', ownerAccessToken: 'owner-token', otherAccessToken: 'other-token' }))"
    const test = scenario === 'public' ? "it('suite pública sem ownership', () => { expect(true).toBe(true) })"
      : scenario === 'skip' ? `describe.skip('disabled',()=>{ ${body} })`
      : scenario === 'todo' ? "it.todo('isolamento executável · public.feedback')"
      : scenario === 'empty' ? "it('isolamento executável · public.feedback',()=>{ expect(true).toBe(true) })"
      : body
    writeFileSync(join(dir, 'supabase/proof.rls.test.ts'), `import { describe,it,expect } from 'vitest'\nimport { isolationTest } from './isolation'\n${test}\n`)
    if (scenario === 'missing') rmSync(join(dir, 'supabase/proof.rls.test.ts'))
    if (scenario === 'partial') writeFileSync(join(dir, 'supabase/migrations/002.sql'), 'create table notes(id uuid, owner_id uuid);')
    if (scenario === 'excluded' || scenario === 'missing') writeFileSync(join(dir, 'supabase/other.rls.test.ts'), "import {it} from 'vitest'; it('unrelated',()=>{})")
    // A pre-existing claim cannot satisfy this run: the gate creates its own report path.
    writeFileSync(join(dir, 'stale.json'), JSON.stringify({ passed: ['public.feedback'], errors: 0 }))
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/rls-isolation-gate.mjs'], {
        cwd: dir, env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${address.port}`, SUPABASE_ANON_KEY: 'public-key', SUPREMO_ISOLATION_REPORT: join(dir, 'stale.json') },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.once('error', reject)
      child.once('exit', (code) => resolve({ code, output }))
    })
    return { ...result, requests }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('gate executável — Vitest real e SDK falando HTTP, sem banco remoto', () => {
  it('tabela pública write-only não exige identidade nem prova cross-user', async () => {
    const result = await executeGate('public')
    expect(result.code).toBe(0)
    expect(result.output).toContain('Isolamento executado para 0 tabela')
    expect(result.requests).toBe(0)
  }, 20_000)
  it('aceita somente prova executada com acesso do dono e bloqueio cruzado', async () => {
    const result = await executeGate('pass')
    expect(result.output).toContain('Isolamento executado para 1 tabela')
    expect(result.code).toBe(0)
    expect(result.requests).toBeGreaterThanOrEqual(7)
  }, 20_000)
  it.each(['missing', 'skip', 'todo', 'empty', 'excluded'] as const)('%s não substitui teste correspondente executado, mesmo com título/relatório antigos', async (scenario) => {
    const result = await executeGate(scenario)
    expect(result.code).toBe(1)
    expect(result.output).toContain('public.feedback')
    expect(result.requests).toBe(0)
  }, 20_000)
  it('prova aprovada de uma tabela não cobre outra adicionada depois', async () => {
    const result = await executeGate('partial')
    expect(result.code).toBe(1)
    expect(result.output).toContain('public.notes (supabase/migrations/002.sql)')
  }, 20_000)
  it.each(['same-user', 'no-row', 'leak', 'write-leak', 'delete-leak', 'network-error'] as const)('reprova fixture ou isolamento inválido: %s', async (scenario) => {
    const result = await executeGate(scenario)
    expect(result.code).toBe(1)
    expect(result.output).toContain('A suíte RLS falhou')
  }, 20_000)
})
