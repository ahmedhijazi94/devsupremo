import { describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import { anonymousSessionHelper } from './anonymous-session'
import { buildProjectFiles } from './project-files'

function helper(session: unknown, sessionError: unknown = null, signupError: unknown = null) {
  const auth = {
    getSession: vi.fn(async () => ({ data: { session }, error: sessionError })),
    signInAnonymously: vi.fn(async () => ({ data: { session: signupError ? null : { user: { id: 'guest-a' } } }, error: signupError })),
  }
  const client = { auth }
  const source = ts.transpileModule(anonymousSessionHelper().replace("import { createBrowserClient } from '@supabase/ssr'", ''), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const exports: { ensurePrivateSession?: () => Promise<unknown> } = {}
  new Function('exports', 'createBrowserClient', 'process', source)(exports, () => client, { env: { NEXT_PUBLIC_SUPABASE_URL: 'https://dev.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-public-key' } })
  return { ensure: exports.ensurePrivateSession!, auth, client }
}

describe('sessão privada do scaffold', () => {
  it('está disponível inclusive em projeto público sem login', () => {
    expect(buildProjectFiles({ projectName: 'guest', description: '', kind: 'public' }).find((f) => f.path === 'lib/supabase/anonymous.ts')?.content).toBe(anonymousSessionHelper())
  })
  it('reutiliza sessão e não cria identidades por render', async () => {
    const h = helper({ user: { id: 'existing' } })
    expect(await h.ensure()).toBe(h.client)
    expect(h.auth.signInAnonymously).not.toHaveBeenCalled()
  })
  it('compartilha a criação concorrente e libera retry após falha', async () => {
    const h = helper(null)
    const first = h.ensure(); const second = h.ensure()
    expect(first).toBe(second)
    await first
    expect(h.auth.signInAnonymously).toHaveBeenCalledTimes(1)
    const failed = helper(null, null, new Error('disabled'))
    await expect(failed.ensure()).rejects.toThrow(/sessão privada/)
    await expect(failed.ensure()).rejects.toThrow(/sessão privada/)
    expect(failed.auth.signInAnonymously).toHaveBeenCalledTimes(2)
  })
  it('erro de sessão nunca vira identidade nova ou dados locais', async () => {
    const h = helper(null, new Error('offline'))
    await expect(h.ensure()).rejects.toThrow(/recuperar/)
    expect(h.auth.signInAnonymously).not.toHaveBeenCalled()
    expect(anonymousSessionHelper()).not.toContain('localStorage')
  })
})
