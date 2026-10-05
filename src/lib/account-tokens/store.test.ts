import { createClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { accountTokenStore } from './store'

const scope = { provider: 'github' as const, accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222' }
const claimId = '33333333-3333-4333-8333-333333333333'
const row = { access_token_encrypted: 'cipher-access', refresh_token_encrypted: 'cipher-refresh', token_expires_at: null, token_refresh_claim: null, token_refresh_started_at: null }

function storage(response: unknown, status = 200): { requests: Request[]; store: ReturnType<typeof accountTokenStore> } {
  const requests: Request[] = []
  const transport: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init))
    return new Response(JSON.stringify(response), { status, headers: { 'Content-Type': 'application/json' } })
  }
  const client = createClient('https://account-store.example.test', 'test-service-role', {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: transport },
  })
  return { requests, store: accountTokenStore(client, scope) }
}

describe('account token storage boundary', () => {
  it('always reads a single account constrained by its authorized owner', async () => {
    const { store, requests } = storage(row)
    expect(await store.read()).toEqual(row)
    const [recorded] = requests
    if (!recorded) throw new Error('Expected the scoped account read request')
    const request = new URL(recorded.url)
    expect(request.pathname).toBe('/rest/v1/github_accounts')
    expect(request.searchParams.get('id')).toBe(`eq.${scope.accountId}`)
    expect(request.searchParams.get('user_id')).toBe(`eq.${scope.userId}`)
    expect(recorded.method).toBe('GET')
  })

  it('reserves and saves only through the scoped server RPCs', async () => {
    const { store, requests } = storage(true)
    expect(await store.claim(row.access_token_encrypted, claimId)).toBe(true)
    expect(await store.finish(row.access_token_encrypted, claimId, row)).toBe(true)
    expect(requests.map(request => new URL(request.url).pathname)).toEqual([
      '/rest/v1/rpc/claim_account_token_refresh', '/rest/v1/rpc/finish_account_token_refresh',
    ])
    const [claimRequest, finishRequest] = requests
    if (!claimRequest || !finishRequest) throw new Error('Expected both scoped refresh RPC requests')
    const args = { p_provider: scope.provider, p_account_id: scope.accountId, p_user_id: scope.userId, p_expected_access: row.access_token_encrypted, p_claim_id: claimId }
    expect(await claimRequest.json()).toEqual(args)
    expect(await finishRequest.json()).toEqual({ ...args, p_access_token_encrypted: row.access_token_encrypted, p_refresh_token_encrypted: row.refresh_token_encrypted, p_token_expires_at: null })
  })

  it('preserves a missing account or failed compare-and-swap without claiming success', async () => {
    expect(await storage(null).store.read()).toBeNull()
    expect(await storage(false).store.claim(row.access_token_encrypted, claimId)).toBe(false)
    expect(await storage(false).store.finish(row.access_token_encrypted, claimId, row)).toBe(false)
  })

  it.each(['read', 'claim', 'finish'] as const)('sanitizes database and transport failures in %s', async (operation) => {
    const call = (store: ReturnType<typeof accountTokenStore>): Promise<unknown> => operation === 'read' ? store.read() : operation === 'claim' ? store.claim(row.access_token_encrypted, claimId) : store.finish(row.access_token_encrypted, claimId, row)
    const { store } = storage({ message: 'SENSITIVE_PROVIDER_TOKEN', details: 'cipher-access' }, 400)
    await expect(call(store)).rejects.toThrow('Não foi possível acessar a conexão da conta.')
    await expect(call(store)).rejects.not.toThrow(/SENSITIVE_PROVIDER_TOKEN|cipher-access/)
    const client = createClient('https://account-store.example.test', 'test-service-role', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: vi.fn<typeof fetch>().mockRejectedValue(new DOMException('SENSITIVE_PROVIDER_TOKEN', 'AbortError')) },
    })
    await expect(call(accountTokenStore(client, scope))).rejects.not.toThrow('SENSITIVE_PROVIDER_TOKEN')
  })

  it('fails closed on malformed storage responses and scope before querying', async () => {
    await expect(storage({ ...row, token_refresh_claim: 'invalid' }).store.read()).rejects.toThrow('Não foi possível acessar a conexão da conta.')
    await expect(storage(null).store.claim(row.access_token_encrypted, claimId)).rejects.toThrow('Não foi possível acessar a conexão da conta.')
    await expect(storage('true').store.finish(row.access_token_encrypted, claimId, row)).rejects.toThrow('Não foi possível acessar a conexão da conta.')
    const transport = vi.fn<typeof fetch>()
    const client = createClient('https://account-store.example.test', 'test-service-role', { global: { fetch: transport } })
    expect(() => accountTokenStore(client, { ...scope, userId: 'unsafe-id' })).toThrow('Não foi possível acessar a conexão da conta.')
    expect(transport).not.toHaveBeenCalled()
  })
})
