import { describe, expect, it } from 'vitest'
import { executableMigrationSql } from './executable-sql'
import { validateAutomaticMigration } from './policy'

describe('migration lexical command boundaries', () => {
  it('distinguishes strings, quoted names and nested comments from executable commands', () => {
    expect(
      executableMigrationSql(
        `INSERT INTO public."notes" (body) VALUES ('DROP TABLE notes;'); /* outer /* inner DROP */ COMMIT */`,
      ),
    ).toContain('public."notes"')
    expect(() =>
      validateAutomaticMigration(
        `INSERT INTO public.notes(body) VALUES (E'DROP TABLE \\'quoted\\';');`,
      ),
    ).not.toThrow()
    expect(() =>
      validateAutomaticMigration(
        `INSERT INTO public.notes(body) VALUES ('BEGIN; COMMIT; SECURITY DEFINER');`,
      ),
    ).not.toThrow()
    expect(() =>
      validateAutomaticMigration(
        `INSERT INTO public.notes(body) VALUES ('safe'); DELETE FROM public.notes;`,
      ),
    ).toThrow()
  })
  it('inspects executable bodies but not strings inside the body', () => {
    const header = `CREATE FUNCTION public.audit() RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS`
    expect(() =>
      validateAutomaticMigration(
        `${header} $$ BEGIN INSERT INTO public.audit(body) VALUES ('DROP TABLE notes'); RETURN NEW; END $$;`,
      ),
    ).not.toThrow()
    expect(() =>
      validateAutomaticMigration(
        `${header} $$ BEGIN EXECUTE 'DROP TABLE notes'; RETURN NEW; END $$;`,
      ),
    ).toThrow()
    expect(() =>
      validateAutomaticMigration(
        `${header} $$ BEGIN DELETE FROM public.notes; RETURN NEW; END $$;`,
      ),
    ).toThrow()
    expect(() =>
      validateAutomaticMigration(
        `CREATE FUNCTION public.hidden() RETURNS integer LANGUAGE sql AS 'DELETE FROM public.notes RETURNING 1'; SELECT public.hidden();`,
      ),
    ).toThrow()
  })
})
