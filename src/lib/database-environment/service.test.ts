import { describe, expect, it, vi } from 'vitest'
import { runDatabaseOperation, type DatabaseOperations } from './service'
const record = { project_ref: 'dev-ref', environment: 'development', source: 'supremo_provisioned' }
const migration = { path: 'supabase/migrations/20260905150000_notes.sql', content: 'create table notes (id uuid primary key); alter table notes enable row level security;' }
function dependencies(): DatabaseOperations {
  return { verify: vi.fn(async () => ({ record, linkedRef: 'dev-ref' })), query: vi.fn(async () => []), configureAuth: vi.fn(async () => {}) }
}
describe('fluxo de banco dev', () => {
  it('consulta a autoridade, aplica o arquivo e registra histórico na mesma transação', async () => {
    const deps = dependencies()
    expect(await runDatabaseOperation(deps, 'dev-ref', 'migrate', [migration])).toEqual({ applied: [migration.path] })
    expect(deps.verify).toHaveBeenCalledTimes(2)
    expect(deps.query).toHaveBeenLastCalledWith('dev-ref', expect.stringContaining(migration.content))
    expect(deps.query).toHaveBeenLastCalledWith('dev-ref', expect.stringContaining('Migration content conflict'))
  })
  it('habilita sessão anônima somente no dev autorizado', async () => {
    const deps = dependencies()
    expect(await runDatabaseOperation(deps, 'dev-ref', 'anonymous-auth')).toMatchObject({ anonymousAuth: true })
    expect(deps.configureAuth).toHaveBeenCalledWith('dev-ref')
    expect(deps.query).not.toHaveBeenCalled()
  })
  it.each(['migrate', 'anonymous-auth'] as const)('produção nunca executa %s', async (op) => {
    const deps = dependencies()
    deps.verify = vi.fn(async () => ({ record: { ...record, environment: 'production' }, linkedRef: 'dev-ref' }))
    await expect(runDatabaseOperation(deps, 'dev-ref', op, [migration])).rejects.toThrow(/não autorizado/)
    expect(deps.query).not.toHaveBeenCalled()
    expect(deps.configureAuth).not.toHaveBeenCalled()
  })
  it('revalida mudança de ambiente antes da escrita', async () => {
    const deps = dependencies()
    deps.verify = vi.fn().mockResolvedValueOnce({ record, linkedRef: 'dev-ref' }).mockResolvedValue({ record: null, linkedRef: 'dev-ref' })
    await expect(runDatabaseOperation(deps, 'dev-ref', 'migrate', [migration])).rejects.toThrow()
    expect(deps.query).toHaveBeenCalledTimes(1)
  })
  it('retry não reaplica migration idêntica; conteúdo alterado falha', async () => {
    const deps = dependencies()
    deps.query = vi.fn(async () => [{ version: '20260905150000', statements: [migration.content] }])
    expect(await runDatabaseOperation(deps, 'dev-ref', 'migrate', [migration])).toEqual({ applied: [] })
    await expect(runDatabaseOperation(deps, 'dev-ref', 'migrate', [{ ...migration, content: 'select 1;' }])).rejects.toThrow(/alterada/)
    deps.query = vi.fn(async () => [{ version: '20260905150000', statements: null }])
    await expect(runDatabaseOperation(deps, 'dev-ref', 'migrate', [migration])).rejects.toThrow(/alterada/)
  })
  it('recusa duplicatas, ordem antiga e SQL sem RLS antes de escrever', async () => {
    const deps = dependencies()
    await expect(runDatabaseOperation(deps, 'dev-ref', 'migrate', [migration, migration])).rejects.toThrow(/duplicadas/)
    deps.query = vi.fn(async () => [{ version: '20260906150000', statements: ['select 1;'] }])
    await expect(runDatabaseOperation(deps, 'dev-ref', 'migrate', [migration])).rejects.toThrow(/fora de ordem/)
    deps.query = vi.fn(async () => [])
    await expect(runDatabaseOperation(deps, 'dev-ref', 'migrate', [{ ...migration, content: 'create table bad (id int);' }])).rejects.toThrow()
    expect(deps.query).toHaveBeenCalledTimes(1)
  })
  it('ordena os arquivos e expõe falha do provedor sem sucesso falso', async () => {
    const deps = dependencies()
    const later = { ...migration, path: 'supabase/migrations/20260905160000_later.sql', content: 'select 1;' }
    expect(await runDatabaseOperation(deps, 'dev-ref', 'migrate', [later, migration])).toEqual({ applied: [migration.path, later.path] })
    deps.configureAuth = vi.fn(async () => { throw new Error('Auth indisponível') })
    await expect(runDatabaseOperation(deps, 'dev-ref', 'anonymous-auth')).rejects.toThrow(/indisponível/)
  })
  it('recusa uma FK sem ON DELETE antes de qualquer migration pendente ser aplicada', async () => {
    const deps = dependencies()
    const invalid = { path: 'supabase/migrations/20260905160000_roles.sql',
      content: 'ALTER TABLE public.orgs ADD COLUMN owner_id uuid REFERENCES auth.users(id);' }
    await expect(runDatabaseOperation(deps, 'dev-ref', 'migrate', [migration, invalid])).rejects.toThrow(/20260905160000_roles.sql:.*ON DELETE/)
    expect(deps.query).toHaveBeenCalledTimes(1)
    expect(deps.query).toHaveBeenCalledWith('dev-ref', expect.stringMatching(/^select version/))
  })
  it('confirma equivalência de FK dentro da transação e preserva o conteúdo do histórico', async () => {
    const deps = dependencies()
    const repair = { ...migration, content: 'ALTER TABLE public.orgs DROP CONSTRAINT orgs_owner_id_fkey, ADD CONSTRAINT orgs_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE NO ACTION;' }
    await expect(runDatabaseOperation(deps, 'dev-ref', 'migrate', [repair])).resolves.toEqual({ applied: [repair.path] })
    const sql = vi.mocked(deps.query).mock.calls.at(-1)![1]
    expect(sql).toContain("set local lock_timeout = '5s';")
    expect(sql).toContain("set local statement_timeout = '20s';")
    expect(sql.indexOf('begin;')).toBeLessThan(sql.indexOf('pg_constraint'))
    expect(sql.indexOf('if not exists')).toBeLessThan(sql.indexOf('pg_constraint'))
    expect(sql.indexOf('pg_constraint')).toBeLessThan(sql.indexOf(repair.content))
    expect(sql).toContain(`array[$supremo_migration$${repair.content}$supremo_migration$]`)
    expect(sql).toContain('Migration content conflict')
  })
  it('não confirma aplicação se o catálogo divergir e não reaplica uma correção registrada', async () => {
    const deps = dependencies()
    const repair = { ...migration, content: 'ALTER TABLE public.orgs DROP CONSTRAINT orgs_owner_id_fkey, ADD CONSTRAINT orgs_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE NO ACTION;' }
    deps.query = vi.fn().mockResolvedValueOnce([]).mockRejectedValue(new Error('FK não equivalente'))
    await expect(runDatabaseOperation(deps, 'dev-ref', 'migrate', [repair])).rejects.toThrow('FK não equivalente')
    deps.query = vi.fn(async () => [{ version: '20260905150000', statements: [repair.content] }])
    await expect(runDatabaseOperation(deps, 'dev-ref', 'migrate', [repair])).resolves.toEqual({ applied: [] })
    expect(deps.query).toHaveBeenCalledTimes(1)
  })
  it('mantém a verificação de conteúdo antes do COMMIT final mesmo com comentário no arquivo', async () => {
    const deps = dependencies()
    const repair = { ...migration, content: '/* commit; */ ALTER TABLE public.orgs DROP CONSTRAINT orgs_owner_id_fkey, ADD CONSTRAINT orgs_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE NO ACTION;' }
    await runDatabaseOperation(deps, 'dev-ref', 'migrate', [repair])
    const sql = vi.mocked(deps.query).mock.calls.at(-1)![1]
    expect(sql).toContain(`execute $supremo_migration$${repair.content}$supremo_migration$;`)
    expect(sql).toContain(`array[$supremo_migration$${repair.content}$supremo_migration$]`)
    expect(sql.indexOf('Migration content conflict')).toBeGreaterThan(sql.lastIndexOf('/* commit; */'))
    expect(sql).toMatch(/end \$supremo_verify\$;\ncommit;$/)
  })
})
