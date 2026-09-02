import { describe, expect, it } from 'vitest'
import { buildInitialMigrationQuery } from './provision'

/**
 * O provisioning aplicava a migration inicial no remoto SEM registrá-la em
 * supabase_migrations.schema_migrations. Resultado: o checkout linkado via CLI
 * via "Local 00000000000000 / Remote vazio" e tentava reaplicar o initial_schema
 * (exigia `migration repair` manual). buildInitialMigrationQuery corrige isso:
 * aplica E registra, atomicamente e idempotente.
 */
describe('buildInitialMigrationQuery', () => {
  const path = 'supabase/migrations/00000000000000_initial_schema.sql'
  const content = "create table public.perfis (id uuid, nome text default 'x');"
  const sql = buildInitialMigrationQuery(path, content)

  it('roda a migration de fato (conteúdo presente)', () => {
    expect(sql).toContain('create table public.perfis')
  })

  it('registra a migration no histórico com version + name do arquivo', () => {
    expect(sql).toContain('supabase_migrations.schema_migrations')
    expect(sql).toContain("'00000000000000'")
    expect(sql).toContain("'initial_schema'")
  })

  it('é idempotente (on conflict do nothing) e atômico (begin/commit)', () => {
    expect(sql).toMatch(/on conflict\s*\(version\)\s*do nothing/i)
    expect(sql.trim().startsWith('begin;')).toBe(true)
    expect(sql.trim().endsWith('commit;')).toBe(true)
  })

  it('cria o schema/tabela de histórico se ainda não existirem (projeto novo)', () => {
    expect(sql).toContain('create schema if not exists supabase_migrations')
    expect(sql).toContain(
      'create table if not exists supabase_migrations.schema_migrations',
    )
  })

  it('usa dollar-quoting no statements — sem quebrar com aspas do conteúdo', () => {
    // o conteúdo tem uma aspa simples (default 'x'); não pode escapar o array
    expect(sql).toContain('$supremo_migration$')
    // a version/name vão como literais escapados
    expect(sql).not.toContain("''00000000000000''")
  })
})
