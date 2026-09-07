import { describe, expect, it } from 'vitest'
import { assertSafeSql } from '../database/sql-guard'
import { validateAutomaticMigration } from '../database-environment/policy'
import { buildProjectFiles } from './project-files'

const modulePath = '../../../scripts/rls-isolation-inventory.mjs'
const { protectedTables, missingProofs } = await import(modulePath) as {
  protectedTables(migrations: Array<{ file: string; source: string }>): Array<{ name: string; file: string }>
  missingProofs(tables: Array<{ name: string; file: string }>, proofs: string[]): Array<{ name: string }>
}

describe('decisão de identidade por requisito, não por persistência', () => {
  it.each(['public', 'solo', 'team'] as const)('orientação consistente em todos os documentos, mesmo com capability Auth (%s)', (kind) => {
    const files = buildProjectFiles({ projectName: 'fixture', description: 'Crie uma página simples com um formulário de nome e mensagem, sem login. Salve as mensagens de forma persistente.', kind })
    const content = (path: string): string => files.find((file) => file.path === path)!.content
    const agents = content('AGENTS.md')
    expect(agents).toContain('Persistência + "sem login" NÃO implica Anonymous Auth')
    expect(agents).toContain('Sem login, sem identidade anônima, sem user_id')
    expect(agents).toContain('Identidade anônima persistente + ownership + RLS')
    expect(agents).toContain('Autenticação normal + ownership + RLS')
    expect(agents).toContain('Não encadeie SELECT/returning')
    expect(agents).toContain('O CI mantém cobertura mínima de 80%')
    expect(agents).toContain('quando o usuário pedir explicitamente')
    const thresholds = content('vitest.config.ts').match(/thresholds:\s*{([^}]+)}/)?.[1]
    expect(thresholds).toBeDefined()
    for (const metric of ['lines', 'functions', 'branches', 'statements']) {
      expect(thresholds).toMatch(new RegExp(metric + ': 80'))
    }
    expect(content('.github/workflows/ci.yml')).toContain('run: npm run test:coverage')
    expect(agents).not.toContain('Toda Server Action começa verificando a sessão')
    expect(content('CLAUDE.md').replace(/\s+/g, ' ')).toContain('Provas cross-user são exigidas pelo CI somente com ownership')
    expect(content('ARCHITECTURE.md')).toContain('autenticar apenas operações que dependem de identidade')
    expect(content('SECURITY.md')).not.toContain('em qualquer policy')
  })

  it('envio público do exemplo real não exige prova cross-user nem ownership', () => {
    const security = buildProjectFiles({ projectName: 'fixture', description: '', kind: 'public' }).find((file) => file.path === 'SECURITY.md')!.content
    const sql = security.match(/```sql\n([\s\S]*?)```/)![1]!
    expect(() => assertSafeSql(sql, { allowDdl: true })).not.toThrow()
    expect(() => validateAutomaticMigration(sql)).not.toThrow()
    expect(sql).not.toContain('user_id')
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain('FOR INSERT TO anon, authenticated WITH CHECK (true)')
    expect(sql).not.toMatch(/FOR (SELECT|UPDATE|DELETE|ALL)/)
    expect(protectedTables([{ file: '001.sql', source: sql }])).toEqual([])
  })

  it.each(['identidade anônima persistente', 'conta autenticada'])('%s continua exigindo prova cross-user', () => {
    const tables = protectedTables([{ file: '001.sql', source: `
      CREATE TABLE public.favorites (id uuid, user_id uuid REFERENCES auth.users(id));
      ALTER TABLE public.favorites ENABLE ROW LEVEL SECURITY;
      CREATE POLICY own ON public.favorites USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
    ` }])
    expect(missingProofs(tables, [])).toEqual([{ name: 'public.favorites', file: '001.sql' }])
    expect(missingProofs(tables, ['public.favorites'])).toEqual([])
  })
})
