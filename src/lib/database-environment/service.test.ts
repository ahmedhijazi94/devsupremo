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
})
