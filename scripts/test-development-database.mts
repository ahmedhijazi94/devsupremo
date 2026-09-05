import { waitForAnonymousAuth } from '../src/lib/database-environment/auth-readiness'
import { readFileSync } from 'node:fs'
/** E2E opt-in: cria um Supabase NOVO descartável. Nunca aceita ref existente. */
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { buildProjectFiles } from '../src/lib/templates/project-files'
import { provisionSupabase } from '../src/lib/provisioning/provision'
import { decryptToken } from '../src/lib/crypto'
import { describeEnvironment, requireDevelopment } from '../src/lib/database-environment/policy'
import { runDatabaseOperation } from '../src/lib/database-environment/service'

if (process.env.SUPREMO_TEST_CREATE_DEV_DATABASE !== '1') throw new Error('Requer SUPREMO_TEST_CREATE_DEV_DATABASE=1; cria e remove apenas um banco novo de teste.')
const control = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const accountId = process.env.SUPREMO_TEST_ACCOUNT_ID
const ownerId = process.env.SUPREMO_TEST_OWNER_ID
if (!accountId || !ownerId) throw new Error('Informe SUPREMO_TEST_ACCOUNT_ID e SUPREMO_TEST_OWNER_ID da conta autorizada.')
const { data: account, error: accountError } = await control.from('supabase_accounts').select('access_token_encrypted').eq('id', accountId).eq('user_id', ownerId).single()
assert.ifError(accountError)
const token = decryptToken(account!.access_token_encrypted as string)
let createdRef: string | null = null
let record: unknown = null
const management = async (ref: string, suffix: string, method: string, body?: unknown) => {
  assert.equal(ref, createdRef, 'Teste só opera no ref retornado pela criação desta execução')
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}${suffix}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`Supabase ${suffix}: HTTP ${response.status}`)
  const text = await response.text()
  return text ? JSON.parse(text) as unknown : null
}
try {
  const files = buildProjectFiles({ projectName: `supremo-e2e-dev-${Date.now()}`, description: 'Banco descartável do teste de ambiente', kind: 'public' })
  await provisionSupabase(control, ownerId, accountId, `supremo-e2e-dev-${Date.now()}`, files, {
    onProjectCreated: async (ref) => {
      createdRef = ref
      record = { project_ref: ref, environment: 'development', source: 'supremo_provisioned' }
      console.log('✓ Provedor criou um banco novo, classificado development nesta execução.')
    },
    verifyDevelopment: async (ref) => { requireDevelopment(record, createdRef, ref) },
  })
  assert(createdRef)
  const ref: string = createdRef
  assert.equal(describeEnvironment(record, ref).automaticMigrations, true)
  const migration = { path: 'supabase/migrations/20260905000001_private_notes.sql', content: readFileSync(new URL('./fixtures/private-notes.sql', import.meta.url), 'utf8')  }
  const operations = {
    verify: async () => ({ record, linkedRef: ref }),
    query: (target: string, sql: string) => management(target, '/database/query', 'POST', { query: sql }),
    configureAuth: async (target: string) => {
      await management(target, '/config/auth', 'PATCH', { external_anonymous_users_enabled: true })
      const config = await management(target, '/config/auth', 'GET') as { external_anonymous_users_enabled: boolean }
      assert.equal(config.external_anonymous_users_enabled, true)
    },
  }
  const migrations = [...files.filter((f) => f.path.startsWith('supabase/migrations/')), migration]
  assert.deepEqual((await runDatabaseOperation(operations, ref, 'migrate', migrations)).applied, [migration.path])
  assert.deepEqual((await runDatabaseOperation(operations, ref, 'migrate', migrations)).applied, [])
  console.log('✓ Migration de feature aplicada no banco dev; repetição idempotente.')
  await runDatabaseOperation(operations, ref, 'anonymous-auth')
  const keys = await management(ref, '/api-keys', 'GET') as Array<{ name: string; api_key: string }>
  const key = keys.find((k) => k.name === 'anon')?.api_key
  assert(key)
  await waitForAnonymousAuth(async () => {
    const response = await fetch(`https://${ref}.supabase.co/auth/v1/settings`, { headers: { apikey: key } })
    const settings = await response.json() as { external?: { anonymous_users?: boolean } }
    return settings.external?.anonymous_users === true
  })
  const a = createClient(`https://${ref}.supabase.co`, key, { auth: { persistSession: false } })
  const b = createClient(`https://${ref}.supabase.co`, key, { auth: { persistSession: false } })
  const first = await a.auth.signInAnonymously(); assert.ifError(first.error); assert(first.data.user?.is_anonymous)
  const second = await b.auth.signInAnonymously(); assert.ifError(second.error); assert(second.data.user?.is_anonymous)
  assert.notEqual(first.data.user.id, second.data.user.id)
  const inserted = await a.from('private_notes').insert({ user_id: first.data.user.id, body: 'privado A' }).select().single()
  assert.ifError(inserted.error)
  const own = await a.from('private_notes').select(); assert.ifError(own.error); assert.equal(own.data?.length, 1)
  const other = await b.from('private_notes').select(); assert.ifError(other.error); assert.equal(other.data?.length, 0)
  const forged = await b.from('private_notes').insert({ user_id: first.data.user.id, body: 'forjado' }); assert(forged.error)
  const changed = await b.from('private_notes').update({ body: 'ataque' }).eq('id', inserted.data.id).select(); assert.ifError(changed.error); assert.equal(changed.data?.length, 0)
  const removed = await b.from('private_notes').delete().eq('id', inserted.data.id).select(); assert.ifError(removed.error); assert.equal(removed.data?.length, 0)
  const refreshed = await a.auth.refreshSession(); assert.ifError(refreshed.error); assert.equal(refreshed.data.user?.id, first.data.user.id)
  console.log('✓ Duas sessões anônimas reais; persistência, refresh e isolamento SELECT/INSERT/UPDATE/DELETE por RLS.')
} finally {
  if (createdRef) {
    await management(createdRef, '', 'DELETE')
    console.log('✓ Apenas o banco descartável criado nesta execução foi removido.')
  }
}
