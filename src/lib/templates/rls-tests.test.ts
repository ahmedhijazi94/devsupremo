import { describe, it, expect } from 'vitest'
import { inferTablesFromMigration, generateRlsTest } from './rls-tests'

/** Uma migration no padrão prédio: tenant, sócios e um recurso do tenant. */
const MULTI_TENANT = `
CREATE TABLE orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);
CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES orgs(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role text NOT NULL
);
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES orgs(id) ON DELETE CASCADE NOT NULL,
  title text NOT NULL
);
`

describe('inferTablesFromMigration — dono direto (a casa)', () => {
  const sql = `
    CREATE TABLE posts (
      id UUID PRIMARY KEY,
      user_id UUID REFERENCES auth.users(id) NOT NULL,
      title TEXT NOT NULL
    );
    CREATE TABLE settings (id UUID PRIMARY KEY, key TEXT NOT NULL);
  `

  it('detecta a coluna de dono', () => {
    const [posts] = inferTablesFromMigration(sql)
    expect(posts?.name).toBe('posts')
    expect(posts?.ownerColumn).toBe('user_id')
    expect(posts?.tenant).toBeUndefined()
  })

  it('ignora tabela sem dono — não há isolamento por linha a provar', () => {
    expect(inferTablesFromMigration(sql).map((t) => t.name)).not.toContain(
      'settings',
    )
  })

  it('sem tabela de sócios, nada vira multi-tenant', () => {
    // Regressão: app de tenant único não pode ganhar teste de tenant por engano.
    expect(inferTablesFromMigration(sql).every((t) => !t.tenant)).toBe(true)
  })
})

describe('inferTablesFromMigration — multi-tenant (o prédio)', () => {
  const specs = inferTablesFromMigration(MULTI_TENANT)
  const byName = (name: string) => specs.find((t) => t.name === name)

  it('a tabela de sócios é dono direto por user_id', () => {
    // Cada linha de vínculo é do próprio usuário. É esse teste que pega a
    // policy de sócios faltando — sem ela, o app inteiro trava fechado.
    expect(byName('memberships')?.ownerColumn).toBe('user_id')
    expect(byName('memberships')?.tenant).toBeUndefined()
  })

  it('o recurso do tenant é reconhecido como multi-tenant', () => {
    const projects = byName('projects')
    expect(projects?.tenant?.column).toBe('org_id')
    expect(projects?.tenant?.isSelf).toBe(false)
    expect(projects?.tenant?.membership.table).toBe('memberships')
    expect(projects?.tenant?.table).toBe('orgs')
  })

  it('a própria tabela de tenant é reconhecida (posse pelo próprio id)', () => {
    const orgs = byName('orgs')
    expect(orgs?.tenant?.isSelf).toBe(true)
    expect(orgs?.tenant?.column).toBe('id')
  })

  it('acha o tenant pela foreign key da coluna de organização', () => {
    // Sem seguir a FK, não dá para semear as organizações do teste.
    expect(byName('projects')?.tenant?.table).toBe('orgs')
  })
})

describe('inferTablesFromMigration — parsing robusto', () => {
  it('lê tabela declarada numa linha só', () => {
    const sql =
      'CREATE TABLE t (id uuid PRIMARY KEY, user_id uuid NOT NULL, name text NOT NULL);'
    const [t] = inferTablesFromMigration(sql)
    expect(t?.name).toBe('t')
    expect(t?.ownerColumn).toBe('user_id')
  })

  it('não se perde com parênteses aninhados no corpo', () => {
    const sql = `CREATE TABLE t (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      amount numeric(10,2) NOT NULL,
      slug text NOT NULL
    );`
    const [t] = inferTablesFromMigration(sql)
    expect(t?.ownerColumn).toBe('user_id')
  })
})

describe('generateRlsTest — teste multi-tenant gerado', () => {
  const code = generateRlsTest(inferTablesFromMigration(MULTI_TENANT))

  it('cobre as três tabelas', () => {
    expect(code).toContain("describe('RLS · memberships'")
    expect(code).toContain('RLS · projects (multi-tenant via memberships)')
    expect(code).toContain('RLS · orgs (tenant, sócios via memberships)')
  })

  it('prova que o membro de outro tenant não toca no recurso alheio', () => {
    expect(code).toContain('membro de OUTRO tenant NÃO lê a linha')
    expect(code).toContain('membro de outro tenant NÃO atualiza a linha')
    expect(code).toContain('membro de outro tenant NÃO deleta a linha')
    expect(code).toContain(
      'membro de outro tenant NÃO grava linha no tenant alheio',
    )
  })

  it('coloca Alice e Bob em tenants diferentes', () => {
    // O que faz o teste provar isolamento por organização, não por usuário.
    expect(code).toMatch(
      /from\('memberships'\)\.insert\(\{\s*org_id: orgA,\s*user_id: aliceId/,
    )
    expect(code).toMatch(
      /from\('memberships'\)\.insert\(\{\s*org_id: orgB,\s*user_id: bobId/,
    )
  })

  it('semeia as organizações na tabela de tenant seguindo a FK', () => {
    expect(code).toContain("from('orgs')")
  })

  it('a tabela de tenant não recebe teste de gravar em tenant alheio', () => {
    // Criar uma organização nova costuma ser aberto; forçar esse teste no
    // próprio tenant geraria falha falsa. Isola só o bloco describe de orgs.
    const start = code.indexOf("describe('RLS · orgs")
    const rest = code.indexOf("describe('", start + 1)
    const orgsSuite = code.slice(start, rest === -1 ? undefined : rest)
    expect(orgsSuite).toContain('membro do tenant lê a linha')
    expect(orgsSuite).not.toContain('grava linha no tenant alheio')
  })
})
