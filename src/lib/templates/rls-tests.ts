/**
 * Gerador de testes de política RLS.
 *
 * É o diferencial que separa "tem CI" de "tem engenharia". A falha de
 * segurança número um de app Supabase é uma policy que parece certa e deixa
 * o usuário A ler a linha do usuário B. Ninguém escreve esse teste à mão;
 * aqui ele sai junto com a tabela.
 *
 * O teste gerado roda contra um Postgres real (Supabase local no CI) e prova,
 * por tabela:
 *   - o dono lê a própria linha
 *   - outro usuário autenticado NÃO lê aquela linha
 *   - a anon key NÃO lê nada
 *   - outro usuário NÃO consegue update nem delete
 *   - não dá para inserir linha em nome de outro
 */

export interface TableSpec {
  name: string
  /** Coluna que aponta para o dono. */
  ownerColumn: string
  /** Colunas obrigatórias além de id e da coluna de dono. */
  requiredColumns?: Array<{ name: string; sampleValue: string }>
}

export function generateRlsTest(tables: TableSpec[]): string {
  const cases = tables.map((table) => renderTableSuite(table)).join('\n')

  return `import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

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

const ALICE = { email: \`alice-\${Date.now()}@rls.test\`, password: 'test-password-123!' }
const BOB = { email: \`bob-\${Date.now()}@rls.test\`, password: 'test-password-123!' }

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

function renderTableSuite(table: TableSpec): string {
  const extras = table.requiredColumns ?? []
  const extraFields = extras
    .map((column) => `    ${column.name}: ${column.sampleValue},`)
    .join('\n')

  const rowLiteral = `{
    ${table.ownerColumn}: aliceId,
${extraFields}
  }`

  return `
describe('RLS · ${table.name}', () => {
  let rowId: string

  beforeAll(async () => {
    const { data, error } = await admin
      .from('${table.name}')
      .insert(${rowLiteral})
      .select('id')
      .single()

    if (error) {
      throw new Error(
        \`Não foi possível semear ${table.name}: \${error.message}\\n\\n\` +
          'Se a tabela não existe, as migrations não foram aplicadas: rode ' +
          'supabase db reset. Se faltou coluna obrigatória, ajuste ' +
          'requiredColumns no gerador de testes.'
      )
    }
    rowId = data.id
  })

  afterAll(async () => {
    await admin.from('${table.name}').delete().eq('id', rowId)
  })

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
      .update({ ${table.ownerColumn}: bobId })
      .eq('id', rowId)
      .select('id')

    expect(data ?? []).toHaveLength(0)

    const { data: unchanged } = await admin
      .from('${table.name}')
      .select('${table.ownerColumn}')
      .eq('id', rowId)
      .single()

    expect(unchanged?.${table.ownerColumn}).toBe(aliceId)
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
    const { error } = await bobClient.from('${table.name}').insert(${rowLiteral.replace(
      `${table.ownerColumn}: aliceId`,
      `${table.ownerColumn}: aliceId`
    )})

    expect(error).not.toBeNull()
  })
})
`
}

/**
 * Lê uma migration e deduz as tabelas que precisam de teste de RLS.
 * Usado tanto pelo scaffold quanto pela ferramenta apply_migration.
 */
export function inferTablesFromMigration(sql: string): TableSpec[] {
  const tables: TableSpec[] = []
  const pattern =
    /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["']?(?:public\.)?(\w+)["']?\s*\(([\s\S]*?)\n\s*\)/gi

  let match: RegExpExecArray | null
  while ((match = pattern.exec(sql)) !== null) {
    const name = match[1]
    const body = match[2]
    if (!name || !body) continue

    const ownerColumn = /\buser_id\b/.test(body)
      ? 'user_id'
      : /\bowner_id\b/.test(body)
        ? 'owner_id'
        : null

    // Sem coluna de dono não há o que testar por linha.
    if (!ownerColumn) continue

    const requiredColumns = [...body.matchAll(/^\s*(\w+)\s+(TEXT|VARCHAR)[^,\n]*NOT NULL/gim)]
      .map((column) => column[1])
      .filter((column): column is string => Boolean(column))
      .filter((column) => column !== ownerColumn)
      .map((column) => ({ name: column, sampleValue: `'teste'` }))

    tables.push({ name, ownerColumn, requiredColumns })
  }

  return tables
}
