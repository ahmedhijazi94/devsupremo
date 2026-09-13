import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateAutomaticMigration } from './policy'

const audit = readFileSync(new URL('./__fixtures__/expense-audit.sql', import.meta.url), 'utf8')
const fn = `CREATE FUNCTION private.audit() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $audit$ BEGIN RETURN NEW; END; $audit$;`
const trigger = 'CREATE TRIGGER record_history AFTER INSERT OR UPDATE OR DELETE ON public.expenses FOR EACH ROW EXECUTE FUNCTION private.audit();'

describe('automatic invoker trigger migrations', () => {
  it('accepts the real expense audit migration without changing its contents', () => {
    expect(() => validateAutomaticMigration(audit)).not.toThrow()
  })
  it('preserves existing additive SQL without the new exception', () => {
    expect(() => validateAutomaticMigration("CREATE FUNCTION public.one() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;")).not.toThrow()
    expect(() => validateAutomaticMigration(String.raw`COMMENT ON TABLE public.expenses IS 'path\notes';`)).not.toThrow()
  })
  it('accepts named dollar quotes, options after the body and multiple static blocks', () => {
    expect(() => validateAutomaticMigration(`${fn} ${trigger}`)).not.toThrow()
    expect(() => validateAutomaticMigration(fn.replace('LANGUAGE plpgsql ', '').replace('$audit$;', '$audit$ LANGUAGE plpgsql;'))).not.toThrow()
    expect(() => validateAutomaticMigration(fn.replace('RETURN NEW;', 'BEGIN NEW.updated_at := now(); END; RETURN NEW;'))).not.toThrow()
  })
  it('does not confuse comment delimiters or semicolons inside values with structure', () => {
    expect(() => validateAutomaticMigration(fn.replace('RETURN NEW;', "RAISE NOTICE 'it''s -- ; /* fine */'; RETURN NEW;"))).not.toThrow()
    expect(() => validateAutomaticMigration(`/* outer /* nested */ still comment */ ${fn} ${trigger}`)).not.toThrow()
  })
  it.each([
    'BEGIN;', 'COMMIT;', 'ROLLBACK;', 'START TRANSACTION;',
    'DELETE FROM public.expenses;', 'UPDATE public.expenses SET paid = true;',
    'DROP TABLE public.expenses;', 'TRUNCATE public.expenses;',
    "DO $$ BEGIN RAISE NOTICE 'no'; END; $$;",
    "EXECUTE FUNCTION public.set_updated_at();",
    "SELECT 'BEGIN; COMMIT;';",
  ])('retains the top-level guard after an accepted function: %s', (sql) => {
    expect(() => validateAutomaticMigration(`${fn} ${trigger} ${sql}`)).toThrow()
  })
  it.each([
    "EXECUTE 'DELETE FROM public.expenses';", "EXECUTE format('%s', 'DROP TABLE public.expenses');",
    'EXECUTE FUNCTION public.set_updated_at();',
    'DELETE FROM public.expenses;', 'UPDATE public.expenses SET paid = true;',
    'COMMIT;', 'ROLLBACK;', 'CALL private.other();',
    'PERFORM private.other();', "PERFORM set_config('row_security', 'off', true);",
    'CREATE TABLE public.hidden (id int);', 'ALTER TABLE public.expenses DISABLE ROW LEVEL SECURITY;',
    'GRANT ALL ON public.expenses TO anon;', 'SET ROLE postgres;',
    'COPY public.expenses TO PROGRAM \'cat\';',
  ])('inspects the function body and refuses hidden operations: %s', (body) => {
    expect(() => validateAutomaticMigration(fn.replace('RETURN NEW;', `${body} RETURN NEW;`))).toThrow()
  })
  it.each([
    fn.replace('SECURITY INVOKER', 'SECURITY DEFINER'),
    fn.replace('SECURITY INVOKER', ''),
    fn.replace('LANGUAGE plpgsql', 'LANGUAGE sql'),
    fn.replace("SET search_path = ''", 'SET search_path = public'),
    fn.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'),
    fn.replace('private.audit()', 'auth.audit()'),
    fn.replace('audit()', 'audit(text)'),
    fn.replace('RETURNS TRIGGER', 'RETURNS void'),
    fn.replace('LANGUAGE plpgsql', 'LANGUAGE plpgsql LANGUAGE plpgsql'),
    fn + fn,
  ])('requires an unambiguous new invoker trigger definition', (sql) => {
    expect(() => validateAutomaticMigration(sql)).toThrow()
  })
  it.each([
    trigger,
    `${trigger} ${fn}`,
    `${fn} ${trigger.replace('private.audit()', 'private.other()')}`,
    `${fn} ${trigger.replace('audit()', "audit('arg')")}`,
    `${fn} ${trigger.replace('public.expenses', 'auth.users')}`,
    `${fn} ${trigger.replace('FOR EACH ROW', 'FOR EACH STATEMENT')}`,
    `-- ${fn.replaceAll('\n', ' ')}\n${trigger}`,
    `SELECT $fake$ ${fn} $fake$; ${trigger}`,
    `${fn} ${trigger.replace('EXECUTE FUNCTION', 'EXECUTE PROCEDURE')}`,
  ])('does not authorize uninspected or differently scoped trigger calls', (sql) => {
    expect(() => validateAutomaticMigration(sql)).toThrow()
  })
  it.each(["SELECT 'unterminated", '/* missing close', 'SELECT $broken$ no close', 'SELECT "no close', String.raw`SELECT E'escaped\'`])('fails closed for unsupported lexical forms: %s', (sql) => {
    expect(() => validateAutomaticMigration(`${fn} ${sql}`)).toThrow()
  })
  it('retains RLS and ownership requirements for the audit table', () => {
    expect(() => validateAutomaticMigration(audit.replace('alter table public.expense_events enable row level security;', ''))).toThrow(/sem RLS/)
    expect(() => validateAutomaticMigration(audit.replace('user_id = (select auth.uid())', 'true'))).toThrow(/verdadeira/)
  })
})
