import { describe, expect, it } from 'vitest'
import { databaseRequestSchema, describeEnvironment, requireDevelopment, validateAutomaticMigration } from './policy'
const dev = { project_ref: 'dev-ref', environment: 'development', source: 'supremo_provisioned' }

describe('autoridade do ambiente', () => {
  it('reconhece apenas development provisionado e com ref correspondente', () => {
    expect(describeEnvironment(dev, 'dev-ref')).toMatchObject({ environment: 'development', automaticMigrations: true })
    expect(requireDevelopment(dev, 'dev-ref', 'dev-ref')).toBe('dev-ref')
  })
  it.each([null, {}, { ...dev, source: 'local' }, { ...dev, environment: 'production' }, { ...dev, project_ref: 'other' }])('recusa ambiente não autorizado: %j', (record) => {
    expect(describeEnvironment(record, 'dev-ref').automaticMigrations).toBe(false)
    expect(() => requireDevelopment(record, 'dev-ref', 'dev-ref')).toThrow(/não autorizado/)
  })
  it('recusa ref do cliente divergente e vínculo removido', () => {
    expect(() => requireDevelopment(dev, 'dev-ref', 'production-ref')).toThrow()
    expect(() => requireDevelopment(dev, null, 'dev-ref')).toThrow()
  })
  it('valida payload sem aceitar autoridade ou caminho arbitrário do cliente', () => {
    const valid = { deviceSecret: 'device-test-fixture', projectId: '00000000-0000-4000-8000-000000000001', operation: 'migrate' }
    expect(databaseRequestSchema.safeParse(valid).success).toBe(true)
    expect(databaseRequestSchema.safeParse({ ...valid, environment: 'development' }).success).toBe(false)
    expect(databaseRequestSchema.safeParse({ ...valid, migrations: [{ path: '../evil.sql', content: 'select 1' }] }).success).toBe(false)
  })
  it('permite DDL aditivo com FK e RLS', () => {
    expect(() => validateAutomaticMigration('create table notes (id uuid primary key, user_id uuid references auth.users(id) on delete cascade); alter table notes enable row level security;')).not.toThrow()
  })
  it.each(['drop table notes;', 'truncate notes;', 'delete from notes;', 'commit;', 'do $$ begin perform 1; end $$;', 'select * from supabase_migrations.schema_migrations;', 'create table notes (id uuid);', 'alter table notes disable row level security;'])('recusa SQL inseguro: %s', (sql) => {
    expect(() => validateAutomaticMigration(sql)).toThrow()
  })
})
