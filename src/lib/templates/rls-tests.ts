/**
 * Gerador de testes de política RLS.
 *
 * É o diferencial que separa "tem CI" de "tem engenharia". A falha de
 * segurança número um de app Supabase é uma policy que parece certa e deixa
 * o usuário A ler a linha do usuário B. Ninguém escreve esse teste à mão;
 * aqui ele sai junto com a tabela.
 *
 * Dois padrões de posse, porque projeto de verdade usa os dois:
 *
 *  - DONO DIRETO: a linha tem user_id/owner_id. É a casa: uma família por
 *    porta. Prova que outro usuário não lê, não altera, não apaga.
 *
 *  - MULTI-TENANT: a linha pertence a uma organização (org_id/team_id/...),
 *    e quem enxerga é decidido por uma tabela de sócios (memberships). É o
 *    prédio: vários andares, cada família no seu. Prova que um membro do
 *    tenant B não toca em nada do tenant A — o furo clássico de SaaS, onde a
 *    policy por engano some com o filtro de organização.
 *
 * O teste gerado roda contra um Postgres real (Supabase local no CI) e prova,
 * por tabela, as cinco+ formas de vazamento entre contas.
 */

export interface Column {
  name: string
  sampleValue: string
}

/** A tabela que liga usuário ↔ tenant. O coração do modelo multi-tenant. */
export interface Membership {
  table: string
  /** Coluna que aponta para o tenant, ex: org_id. */
  tenantColumn: string
  /** Coluna que aponta para o usuário, ex: user_id. */
  userColumn: string
  /** Colunas NOT NULL a preencher ao semear um sócio. */
  requiredColumns: Column[]
}

export interface TableSpec {
  name: string
  requiredColumns: Column[]
  /** Presente quando a posse é por dono direto (user_id/owner_id). */
  ownerColumn?: string
  /** FK da própria tabela de membros: precisa de um tenant real no fixture. */
  membershipParent?: { column: string; table: string; requiredColumns: Column[] }
  /** Presente quando a posse é por organização (multi-tenant). */
  tenant?: {
    /** Coluna desta tabela que aponta para o tenant, ou 'id' se ela é o tenant. */
    column: string
    /** true quando ESTA tabela é o próprio tenant (orgs); o tenant é o id dela. */
    isSelf: boolean
    membership: Membership
    /** Tabela do tenant para semear as organizações; null usa uuid solto. */
    table: string | null
    /** Colunas NOT NULL a preencher ao semear uma organização. */
    tableRequiredColumns: Column[]
  }
}

// ─────────────────────────────────────────────────────────────
// Geração do arquivo de teste
// ─────────────────────────────────────────────────────────────

export function generateRlsTest(tables: TableSpec[]): string {
  // App público não tem tabela com dono nem tenant — não há isolamento por
  // linha a provar. Ainda assim o job "Políticas RLS" roda este arquivo, e um
  // arquivo sem nenhum teste faria o vitest reclamar. Um teste que afirma
  // exatamente isso mantém o gate verde e honesto.
  if (tables.length === 0) {
    return `import { describe, it, expect } from 'vitest'

/**
 * Este app não tem tabelas com posse por usuário ou por tenant, então não há
 * isolamento entre contas a provar. Quando a primeira tabela com user_id,
 * owner_id ou org_id chegar, o teste de isolamento dela nasce aqui.
 */
describe('RLS', () => {
  it('sem tabela de dono ou tenant — nada a isolar', () => {
    expect(true).toBe(true)
  })
})
`
  }

  const cases = tables
    .map((table) =>
      table.tenant ? renderTenantSuite(table) : renderDirectSuite(table),
    )
    .join('\n')

  return `import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { isolationTest } from './isolation'

/**
 * Testes de política RLS — gerados pelo Supremo.
 *
 * Provam que o isolamento entre contas existe de verdade, e não só no
 * texto da policy. Rodam contra um Postgres real; no CI o Supabase local
 * é levantado antes desta suíte.
 *
 * Se um destes testes falhar, existe vazamento entre contas. Não marque
 * como skip: corrija a policy.
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

if (!ANON_KEY || !SERVICE_KEY) {
  throw new Error(
    [
      'Os testes de RLS precisam de um Postgres real — eles provam que o',
      'isolamento entre contas existe de verdade, não só no texto da policy.',
      '',
      'Localmente:',
      '  supabase start',
      '  SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=...',
      '  (os valores saem de: supabase status)',
      '  npm run test:rls',
      '',
      'No CI isso já acontece no job "Políticas RLS".',
    ].join('\\n')
  )
}

const ALICE = { email: \`alice-\${crypto.randomUUID()}@rls.test\`, password: 'test-password-123!' }
const BOB = { email: \`bob-\${crypto.randomUUID()}@rls.test\`, password: 'test-password-123!' }

let admin: SupabaseClient
let aliceClient: SupabaseClient
let bobClient: SupabaseClient
let anonClient: SupabaseClient
let aliceId: string
let bobId: string

beforeAll(async () => {
  admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  aliceId = await createUser(ALICE)
  bobId = await createUser(BOB)

  aliceClient = await signIn(ALICE)
  bobClient = await signIn(BOB)
  anonClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
})

afterAll(async () => {
  await admin.auth.admin.deleteUser(aliceId).catch(() => undefined)
  await admin.auth.admin.deleteUser(bobId).catch(() => undefined)
})

async function createUser(credentials: { email: string; password: string }) {
  const { data, error } = await admin.auth.admin.createUser({
    email: credentials.email,
    password: credentials.password,
    email_confirm: true,
  })
  if (error) throw new Error(\`Falha ao criar usuário de teste: \${error.message}\`)
  return data.user.id
}

async function signIn(credentials: { email: string; password: string }) {
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error } = await client.auth.signInWithPassword(credentials)
  if (error) throw new Error(\`Falha ao autenticar: \${error.message}\`)
  return client
}

${cases}`
}

// ─────────────────────────────────────────────────────────────
// Dono direto — a casa
// ─────────────────────────────────────────────────────────────

function renderDirectSuite(table: TableSpec): string {
  const owner = table.ownerColumn ?? 'user_id'
  const parent = table.membershipParent
  const extraFields = (table.requiredColumns ?? [])
    .map((column) => `    ${column.name}: ${column.sampleValue},`)
    .join('\n')

  const rowLiteral = `{
    ${owner}: aliceId,
${parent ? `    ${parent.column}: parentId,` : ''}
${extraFields}
  }`

  return `
describe('RLS · ${table.name}', () => {
  let rowId: string
${parent ? '  let parentId: string' : ''}

  beforeAll(async () => {
${parent ? `    const { data: parent, error: parentError } = await admin.from('${parent.table}')
      .insert({
${fields(parent.requiredColumns, '        ')}
      }).select('id').single()
    if (parentError) throw new Error(parentError.message)
    parentId = parent.id
` : ''}
    const { data, error } = await admin
      .from('${table.name}')
      .insert(${rowLiteral})
      .select('id')
      .single()

    if (error) {
      throw new Error(
        \`Não foi possível semear ${table.name}: \${error.message}\\n\\n\` +
          'Se a tabela não existe, as migrations não foram aplicadas: rode ' +
          'supabase db reset.'
      )
    }
    rowId = data.id
  })

  afterAll(async () => {
    await admin.from('${table.name}').delete().eq('id', rowId)
${parent ? `    await admin.from('${parent.table}').delete().eq('id', parentId)` : ''}
  })

  ${isolationRegistration(table.name)}

  it('o dono lê a própria linha', async () => {
    const { data, error } = await aliceClient
      .from('${table.name}')
      .select('id')
      .eq('id', rowId)

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it('outro usuário autenticado NÃO lê a linha', async () => {
    const { data } = await bobClient
      .from('${table.name}')
      .select('id')
      .eq('id', rowId)

    expect(data ?? []).toHaveLength(0)
  })

  it('a anon key NÃO lê a linha', async () => {
    const { data } = await anonClient
      .from('${table.name}')
      .select('id')
      .eq('id', rowId)

    expect(data ?? []).toHaveLength(0)
  })

  it('outro usuário NÃO consegue atualizar a linha', async () => {
    const { data } = await bobClient
      .from('${table.name}')
      .update({ ${owner}: bobId })
      .eq('id', rowId)
      .select('id')

    expect(data ?? []).toHaveLength(0)

    const { data: unchanged } = await admin
      .from('${table.name}')
      .select('${owner}')
      .eq('id', rowId)
      .single()

    expect(unchanged?.${owner}).toBe(aliceId)
  })

  it('outro usuário NÃO consegue deletar a linha', async () => {
    await bobClient.from('${table.name}').delete().eq('id', rowId)

    const { data: stillThere } = await admin
      .from('${table.name}')
      .select('id')
      .eq('id', rowId)

    expect(stillThere ?? []).toHaveLength(1)
  })

  it('não é possível inserir linha em nome de outro usuário', async () => {
    const { error } = await bobClient.from('${table.name}').insert(${rowLiteral})

    expect(error).not.toBeNull()
  })
})
`
}

// ─────────────────────────────────────────────────────────────
// Multi-tenant — o prédio
// ─────────────────────────────────────────────────────────────

/** Campos `coluna: valor,` para um insert, indentados. */
function fields(columns: Column[], indent: string): string {
  return columns
    .map((column) => `${indent}${column.name}: ${column.sampleValue},`)
    .join('\n')
}

function renderTenantSuite(table: TableSpec): string {
  const t = table.tenant!
  const m = t.membership

  // Como nasce uma organização de teste. Com tabela de tenant conhecida,
  // semeamos a linha (o service role ignora o RLS). Sem FK conhecida, um uuid
  // solto basta e não esbarra em constraint.
  const makeOrg = t.table
    ? `async (): Promise<string> => {
    const { data, error } = await admin
      .from('${t.table}')
      .insert({
${fields(t.tableRequiredColumns, '        ')}
      })
      .select('id')
      .single()
    if (error) throw new Error(\`semear ${t.table}: \${error.message}\`)
    return data.id as string
  }`
    : `async (): Promise<string> => crypto.randomUUID()`

  // Vincula um usuário a uma organização.
  const enroll = (org: string, user: string) =>
    `await admin.from('${m.table}').insert({
      ${m.tenantColumn}: ${org},
      ${m.userColumn}: ${user},
${fields(m.requiredColumns, '      ')}
    })`

  const label = t.isSelf
    ? `RLS · ${table.name} (tenant, sócios via ${m.table})`
    : `RLS · ${table.name} (multi-tenant via ${m.table})`

  // Quando a tabela É o tenant, a linha sob teste é a própria organização A.
  // Quando é um recurso do tenant, criamos uma linha marcada com a org A.
  const seedRow = t.isSelf
    ? `    rowId = orgA`
    : `    const { data, error } = await admin
      .from('${table.name}')
      .insert({
        ${t.column}: orgA,
${fields(table.requiredColumns, '        ')}
      })
      .select('id')
      .single()
    if (error) {
      throw new Error(
        \`Não foi possível semear ${table.name}: \${error.message}\\n\\n\` +
          'Se a tabela não existe, rode supabase db reset.'
      )
    }
    rowId = data.id`

  // A organização A é apagada no fim; o FK em cascata leva sócios e recursos.
  // Sem tabela de tenant conhecida, apagamos o recurso à mão.
  const cleanup = t.table
    ? `    await admin.from('${t.table}').delete().in('id', [orgA, orgB])`
    : `    await admin.from('${table.name}').delete().eq('id', rowId)
    await admin.from('${m.table}').delete().in('${m.tenantColumn}', [orgA, orgB])`

  // O membro do tenant errado tentando inserir no tenant A. Só faz sentido
  // para recurso — criar uma organização nova costuma ser aberto.
  const insertGuard = t.isSelf
    ? ''
    : `
  it('membro de outro tenant NÃO grava linha no tenant alheio', async () => {
    const { error } = await bobClient.from('${table.name}').insert({
      ${t.column}: orgA,
${fields(table.requiredColumns, '      ')}
    })

    expect(error).not.toBeNull()
  })`

  return `
describe('${label}', () => {
  let orgA: string
  let orgB: string
  let rowId: string

  beforeAll(async () => {
    const makeOrg = ${makeOrg}

    orgA = await makeOrg()
    orgB = await makeOrg()

    // Alice é do tenant A, Bob é do tenant B. É o que faz o teste provar
    // isolamento por organização, não por usuário.
    ${enroll('orgA', 'aliceId')}
    ${enroll('orgB', 'bobId')}

${seedRow}
  })

  afterAll(async () => {
${cleanup}
  })

  ${isolationRegistration(table.name)}

  it('membro do tenant lê a linha', async () => {
    const { data, error } = await aliceClient
      .from('${table.name}')
      .select('id')
      .eq('id', rowId)

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it('membro de OUTRO tenant NÃO lê a linha', async () => {
    const { data } = await bobClient
      .from('${table.name}')
      .select('id')
      .eq('id', rowId)

    expect(data ?? []).toHaveLength(0)
  })

  it('não pode se associar ao tenant alheio usando o próprio usuário', async () => {
    const { error } = await bobClient.from('${m.table}').insert({
      ${m.tenantColumn}: orgA,
      ${m.userColumn}: bobId,
${fields(m.requiredColumns, '      ')}
    })
    // Limpa até num baseline vulnerável para não contaminar os outros testes.
    await admin.from('${m.table}').delete()
      .eq('${m.tenantColumn}', orgA).eq('${m.userColumn}', bobId)
    expect(error?.code).toBe('42501')
  })

  it('a anon key NÃO lê a linha', async () => {
    const { data } = await anonClient
      .from('${table.name}')
      .select('id')
      .eq('id', rowId)

    expect(data ?? []).toHaveLength(0)
  })

  it('membro de outro tenant NÃO atualiza a linha', async () => {
    const { data: changed } = await bobClient
      .from('${table.name}')
      .update({ id: rowId })
      .eq('id', rowId)
      .select('id')
    expect(changed ?? []).toHaveLength(0)

    const { data: stillThere } = await admin
      .from('${table.name}')
      .select('id')
      .eq('id', rowId)

    expect(stillThere ?? []).toHaveLength(1)
  })

  it('membro de outro tenant NÃO deleta a linha', async () => {
    await bobClient.from('${table.name}').delete().eq('id', rowId)

    const { data: stillThere } = await admin
      .from('${table.name}')
      .select('id')
      .eq('id', rowId)

    expect(stillThere ?? []).toHaveLength(1)
  })${insertGuard}
})
`
}

// ─────────────────────────────────────────────────────────────
// Detecção a partir da migration
// ─────────────────────────────────────────────────────────────

/** Nomes conhecidos de coluna de tenant. Lista fechada evita falso positivo. */
const TENANT_COLUMNS = [
  'org_id',
  'organization_id',
  'team_id',
  'workspace_id',
  'account_id',
  'tenant_id',
  'company_id',
  'group_id',
]

interface ParsedTable {
  name: string
  body: string
}

function parseTables(sql: string): ParsedTable[] {
  // O corpo é lido por parênteses balanceados, não por regex de fim de linha:
  // migration real vem multi-linha, mas apply_migration aceita o que o agente
  // escrever, inclusive tudo numa linha só. Uma versão anterior casava só o
  // `)` em linha própria e não via nenhuma tabela nesse caso.
  const head =
    /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["']?(?:public\.)?(\w+)["']?\s*\(/gi
  const tables: ParsedTable[] = []
  let match: RegExpExecArray | null

  while ((match = head.exec(sql)) !== null) {
    const name = match[1]
    if (!name) continue

    const open = head.lastIndex - 1
    let depth = 0
    let end = -1
    for (let i = open; i < sql.length; i++) {
      const char = sql[i]
      if (char === '(') depth++
      else if (char === ')') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) continue

    tables.push({ name, body: sql.slice(open + 1, end) })
    head.lastIndex = end
  }

  return tables
}

function hasColumn(body: string, column: string): boolean {
  return new RegExp(`\\b${column}\\b`, 'i').test(body)
}

function tenantColumnOf(body: string): string | null {
  return TENANT_COLUMNS.find((c) => hasColumn(body, c)) ?? null
}

/** Alvo da foreign key de uma coluna: `col ... REFERENCES [public.]tabela(...`. */
function fkTarget(body: string, column: string): string | null {
  const re = new RegExp(
    `\\b${column}\\b[^,]*?\\breferences\\s+(?:public\\.)?["']?(\\w+)`,
    'i',
  )
  return re.exec(body)?.[1] ?? null
}

/** Colunas TEXT/VARCHAR NOT NULL, que precisam de valor ao semear a linha. */
function requiredTextColumns(body: string, exclude: string[]): Column[] {
  return [...body.matchAll(/^\s*(\w+)\s+(TEXT|VARCHAR)[^,\n]*NOT NULL/gim)]
    .map((column) => column[1])
    .filter((name): name is string => Boolean(name))
    .filter((name) => !exclude.includes(name))
    .map((name) => ({ name, sampleValue: `'teste'` }))
}

/** A tabela de sócios: tem coluna de usuário E coluna de tenant. */
function findMembership(tables: ParsedTable[]): Membership | null {
  const candidates = tables.filter(
    (t) => hasColumn(t.body, 'user_id') && tenantColumnOf(t.body),
  )
  if (candidates.length === 0) return null

  // Se houver mais de uma, a que se chama de sócios ganha.
  candidates.sort((a, b) => {
    const am = /member|soci|participa/i.test(a.name) ? 0 : 1
    const bm = /member|soci|participa/i.test(b.name) ? 0 : 1
    return am - bm
  })

  const chosen = candidates[0]!
  const tenantColumn = tenantColumnOf(chosen.body)!
  return {
    table: chosen.name,
    tenantColumn,
    userColumn: 'user_id',
    requiredColumns: requiredTextColumns(chosen.body, [
      tenantColumn,
      'user_id',
    ]),
  }
}

/**
 * Lê uma migration e deduz as tabelas que precisam de teste de RLS, e por
 * qual padrão de posse. Usado pelo scaffold e por apply_migration.
 */
export function inferTablesFromMigration(sql: string): TableSpec[] {
  const parsed = parseTables(sql)
  const membership = findMembership(parsed)
  const tenantTable = membership
    ? fkTarget(
        parsed.find((t) => t.name === membership.table)?.body ?? '',
        membership.tenantColumn,
      )
    : null
  const tenantTableRequired =
    tenantTable !== null
      ? requiredTextColumns(
          parsed.find((t) => t.name === tenantTable)?.body ?? '',
          [],
        )
      : []

  const specs: TableSpec[] = []

  for (const { name, body } of parsed) {
    const direct = hasColumn(body, 'user_id')
      ? 'user_id'
      : hasColumn(body, 'owner_id')
        ? 'owner_id'
        : null

    // A própria tabela de sócios: cada linha é do usuário dela. Dono direto
    // prova que um usuário não lê o vínculo de outro.
    if (membership && name === membership.table) {
      const parent = parsed.find((t) => t.name === tenantTable)
      specs.push({
        name,
        ownerColumn: 'user_id',
        requiredColumns: requiredTextColumns(body, [
          'user_id',
          membership.tenantColumn,
        ]),
        ...(parent ? { membershipParent: {
          column: membership.tenantColumn,
          table: parent.name,
          requiredColumns: requiredTextColumns(parent.body, ['id']),
        } } : {}),
      })
      continue
    }

    // Recurso de tenant: tem a coluna de organização, e há sócios para mediar.
    const tenantCol = membership ? tenantColumnOf(body) : null
    if (membership && tenantCol) {
      specs.push({
        name,
        requiredColumns: requiredTextColumns(body, [tenantCol]),
        tenant: {
          column: tenantCol,
          isSelf: false,
          membership,
          table: fkTarget(body, tenantCol) ?? tenantTable,
          tableRequiredColumns: tenantTableRequired,
        },
      })
      continue
    }

    // A própria tabela de tenant (orgs): quem a vê é membro dela. O tenant é
    // o id da própria linha.
    if (membership && tenantTable && name === tenantTable) {
      specs.push({
        name,
        requiredColumns: requiredTextColumns(body, []),
        tenant: {
          column: 'id',
          isSelf: true,
          membership,
          table: name,
          tableRequiredColumns: requiredTextColumns(body, []),
        },
      })
      continue
    }

    // Dono direto comum (user_id/owner_id) fora do modelo de tenant.
    if (direct) {
      specs.push({
        name,
        ownerColumn: direct,
        requiredColumns: requiredTextColumns(body, [direct]),
      })
      continue
    }

    // Sem coluna de dono nem de tenant: não há isolamento por linha a provar.
  }

  return specs
}

function isolationRegistration(table: string): string {
  return `isolationTest('public.${table}', async () => {
    const owner = await aliceClient.auth.getSession()
    const other = await bobClient.auth.getSession()
    if (!owner.data.session || !other.data.session) throw new Error('Sessões da fixture ausentes.')
    return { rowId, ownerAccessToken: owner.data.session.access_token, otherAccessToken: other.data.session.access_token }
  })`
}
