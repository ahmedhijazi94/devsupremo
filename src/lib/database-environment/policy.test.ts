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
    const valid = { deviceSecret: 'device-test-fixture', projectId: '00000000-0000-4000-8000-000000000001', operation: 'migrate', expectedRef:'dev-ref',operationId:'00000000-0000-4000-8000-000000000099' }
    expect(databaseRequestSchema.safeParse(valid).success).toBe(true)
    expect(databaseRequestSchema.safeParse({ ...valid, environment: 'development' }).success).toBe(false)
    expect(databaseRequestSchema.safeParse({ ...valid, migrations: [{ path: '../evil.sql', content: 'select 1' }] }).success).toBe(false)
  })
  it('permite DDL aditivo com FK e RLS', () => {
    expect(() => validateAutomaticMigration('create table notes (id uuid primary key, user_id uuid references auth.users(id) on delete cascade); alter table notes enable row level security;')).not.toThrow()
  })
  it('direciona a exclusão delimitada ao canal implementado, sem prometer revisão de SQL arbitrário', () => {
    expect(() => validateAutomaticMigration("DELETE FROM public.orgs WHERE id = '00000000-0000-4000-8000-000000000001';"))
      .toThrow('Migration recusada: operação destrutiva, dinâmica ou controle de transação não permitido no fluxo automático. Para excluir linhas específicas autorizadas em development, use data delete-plan e data delete-apply. SQL destrutivo arbitrário não é suportado por esse canal; salvar um arquivo para revisão não enfileira sua aplicação.')
  })
  it('permite inserir o administrador confirmado de forma idempotente, sem confundir DO NOTHING com bloco DO', () => {
    expect(() => validateAutomaticMigration(`
      INSERT INTO public.platform_admins (user_id)
      SELECT id FROM auth.users
      WHERE id = '00000000-0000-4000-8000-000000000001'::uuid
        AND email_confirmed_at IS NOT NULL
      ON CONFLICT (user_id) DO NOTHING;
    `)).not.toThrow()
  })
  it.each([
    'ON CONFLICT DO NOTHING',
    'on conflict (user_id) do nothing',
    'ON\nCONFLICT (user_id, org_id)\nDO\nNOTHING',
    'ON CONFLICT (user_id) DO /* explanatory comment */ NOTHING',
  ])('permite a cláusula idempotente estática: %s', (clause) => {
    expect(() => validateAutomaticMigration(`INSERT INTO public.members (user_id, org_id) VALUES ('user', 'org') ${clause};`)).not.toThrow()
  })
  it.each([
    'ON CONFLICT (user_id) DO UPDATE SET org_id = excluded.org_id;',
    'ON CONFLICT (user_id) DO NOTHING; DO $$ SELECT 1; $$;',
    'ON CONFLICT (user_id) DO NOTHING; DROP TABLE public.members;',
    'ON CONFLICT (user_id) DO NOTHING; UPDATE public.members SET org_id = NULL;',
    'ON CONFLICT (user_id) DO NOTHING; DELETE FROM public.members;',
    'ON CONFLICT (user_id) DO NOTHING; COMMIT;',
    "ON CONFLICT (user_id) DO NOTHING; EXECUTE 'SELECT 1';",
    'ON CONFLICT (user_id) DO NOTHING; ALTER TABLE public.members DISABLE ROW LEVEL SECURITY;',
    'ON CONFLICT (lower(user_id)) DO NOTHING;',
  ])('a exceção idempotente não libera outros comandos ou sintaxe ambígua: %s', (suffix) => {
    expect(() => validateAutomaticMigration(`INSERT INTO public.members (user_id) VALUES ('user') ${suffix}`)).toThrow()
  })
  it('distingue texto de comandos executáveis, mantendo o guard na origem do INSERT', () => {
    expect(() => validateAutomaticMigration(`INSERT INTO public.notes (body) VALUES ('DROP TABLE notes') ON CONFLICT DO NOTHING;`)).not.toThrow()
    expect(() => validateAutomaticMigration(`INSERT INTO public.notes (body) VALUES ($text$BEGIN; SECURITY DEFINER; DROP TABLE notes$text$); /* DROP TABLE notes */`)).not.toThrow()
    expect(() => validateAutomaticMigration(`INSERT INTO public.notes (body) SELECT pg_read_file('/etc/passwd') ON CONFLICT DO NOTHING;`)).toThrow()
    expect(() => validateAutomaticMigration(`INSERT INTO public.notes (body) VALUES ('ON CONFLICT DO NOTHING'); DO $$ SELECT 1; $$;`)).toThrow()
  })
  it('permite o trigger de updated_at usado pela feature real do v3-21', () => {
    expect(() => validateAutomaticMigration('CREATE TRIGGER suggestions_updated_at BEFORE UPDATE ON public.suggestions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();')).not.toThrow()
  })
  it.each([
    'CREATE TRIGGER t BEFORE UPDATE ON public.suggestions FOR EACH ROW EXECUTE FUNCTION public.other();',
    "CREATE TRIGGER t BEFORE UPDATE ON public.suggestions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at('argument');",
    "EXECUTE 'DELETE FROM suggestions';",
  ])('continua recusando execução arbitrária: %s', (sql) => {
    expect(() => validateAutomaticMigration(sql)).toThrow()
  })
  it.each(['drop table notes;', 'truncate notes;', 'delete from notes;', 'commit;', 'do $$ begin perform 1; end $$;', 'select * from supabase_migrations.schema_migrations;', 'create table notes (id uuid);', 'alter table notes disable row level security;'])('recusa SQL inseguro: %s', (sql) => {
    expect(() => validateAutomaticMigration(sql)).toThrow()
  })
})
