import fs from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

interface UserReply { data: { user: { id: string } | null }; error: Error | null }
interface SessionReply { data: { user: { id: string } | null; session: { access_token: string } | null }; error: Error | null }

function fixture() {
  const createUser = vi.fn<() => Promise<UserReply>>().mockResolvedValue({ data: { user: { id: 'synthetic-one' } }, error: null })
  const deleteUser = vi.fn<(_id: string) => Promise<{ error: Error | null }>>().mockResolvedValue({ error: null })
  const signInWithPassword = vi.fn<() => Promise<SessionReply>>().mockResolvedValue({
    data: { user: { id: 'synthetic-one' }, session: { access_token: 'memory-only-session' } }, error: null,
  })
  const client = { auth: { signInWithPassword } }
  const createClient = vi.fn(() => client)
  const admin = { auth: { admin: { createUser, deleteUser } } }
  const source = fs.readFileSync('src/lib/templates/assets/rls/test-users.ts.txt', 'utf8')
    .replace("import { createClient, type SupabaseClient } from '@supabase/supabase-js'", '')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exported: { createRlsTestUsers?: (options: { admin: typeof admin; url: string; anonKey: string }) => {
    create(): Promise<{ id: string; client: typeof client; accessToken: string }>; cleanup(): Promise<void>
  } } = {}
  new Function('exports', 'createClient', compiled)(exported, createClient)
  const users = exported.createRlsTestUsers!({ admin, url: 'http://127.0.0.1:54321', anonKey: 'test-public-key' })
  return { users, createUser, deleteUser, signInWithPassword, createClient, client }
}

describe('reusable RLS synthetic identities', () => {
  it('returns an authenticated ordinary client and removes only identities created by the fixture', async () => {
    const f = fixture()
    expect(await f.users.create()).toEqual({ id: 'synthetic-one', client: f.client, accessToken: 'memory-only-session' })
    expect(f.createClient).toHaveBeenCalledWith('http://127.0.0.1:54321', 'test-public-key', {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    await f.users.cleanup()
    await f.users.cleanup()
    expect(f.deleteUser.mock.calls).toEqual([['synthetic-one']])
  })

  it('keeps partial creations available for cleanup without leaking provider errors', async () => {
    const f = fixture()
    f.createUser.mockResolvedValueOnce({ data: { user: { id: 'partial' } }, error: new Error('private provider context') })
    await expect(f.users.create()).rejects.toThrow('Não foi possível criar a identidade sintética do teste RLS.')
    expect(f.signInWithPassword).not.toHaveBeenCalled()
    await f.users.cleanup()
    expect(f.deleteUser).toHaveBeenCalledWith('partial')
  })

  it.each(['wrong-user', 'missing-token', 'auth-error', 'rejection'] as const)('rejects %s and still cleans the created identity', async kind => {
    const f = fixture()
    if (kind === 'rejection') f.signInWithPassword.mockRejectedValueOnce(new Error('private credentials'))
    else f.signInWithPassword.mockResolvedValueOnce({
      data: { user: { id: kind === 'wrong-user' ? 'another-user' : 'synthetic-one' }, session: kind === 'missing-token' ? null : { access_token: 'token' } },
      error: kind === 'auth-error' ? new Error('private credentials') : null,
    })
    await expect(f.users.create()).rejects.toThrow('Não foi possível autenticar a identidade sintética do teste RLS. Execute cleanup() em afterAll.')
    await f.users.cleanup()
    expect(f.deleteUser).toHaveBeenCalledWith('synthetic-one')
  })

  it('attempts every cleanup, reports failures and retries only remaining identities', async () => {
    const f = fixture()
    await f.users.create()
    f.createUser.mockResolvedValueOnce({ data: { user: { id: 'synthetic-two' } }, error: null })
    f.signInWithPassword.mockResolvedValueOnce({ data: { user: { id: 'synthetic-two' }, session: { access_token: 'second' } }, error: null })
    await f.users.create()
    f.deleteUser.mockRejectedValueOnce(new Error('network credentials')).mockResolvedValueOnce({ error: null })
    await expect(f.users.cleanup()).rejects.toThrow('Não foi possível remover 1 identidade(s) sintética(s)')
    expect(f.deleteUser.mock.calls).toEqual([['synthetic-one'], ['synthetic-two']])
    await f.users.cleanup()
    expect(f.deleteUser.mock.calls).toEqual([['synthetic-one'], ['synthetic-two'], ['synthetic-one']])
  })

  it('does not invent an identity to remove after an unsuccessful creation', async () => {
    const f = fixture()
    f.createUser.mockRejectedValueOnce(new Error('provider unavailable'))
    await expect(f.users.create()).rejects.toThrow('criar a identidade')
    await f.users.cleanup()
    expect(f.deleteUser).not.toHaveBeenCalled()
  })
})
