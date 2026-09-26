import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { claimFunctionLease } from './store'
const scope = { projectId: '00000000-0000-4000-8000-000000000001', ownerId: '00000000-0000-4000-8000-000000000002', projectRef: 'own-ref', environment: 'development' as const }
const rpc = vi.fn(), remove = vi.fn(), eq = vi.fn(), from = vi.fn()
const client = { rpc, from } as unknown as SupabaseClient
beforeEach(() => {
  vi.resetAllMocks()
  rpc.mockResolvedValue({ data: new Date(Date.now() + 120_000).toISOString(), error: null })
  eq.mockReturnValue({ eq, error: null }); remove.mockReturnValue({ eq }); from.mockReturnValue({ delete: remove })
})
describe('durable function mutation lease', () => {
  it('claims scoped UUID, verifies before calls, and releases by token CAS', async () => {
    const lease = await claimFunctionLease(client, scope)
    const args = rpc.mock.calls[0]![1] as Record<string, unknown>
    expect(rpc).toHaveBeenCalledWith('claim_function_operation', { p_project_id: scope.projectId, p_user_id: scope.ownerId,
      p_target_ref: scope.projectRef, p_environment: scope.environment, p_claim_token: expect.any(String) })
    expect(args.p_claim_token).toMatch(/^[a-f0-9-]{36}$/)
    rpc.mockResolvedValue({ data: true, error: null })
    await lease.assertCurrent(); expect(rpc).toHaveBeenLastCalledWith('verify_function_operation', args)
    await lease.release()
    expect(from).toHaveBeenCalledWith('function_operation_leases')
    expect(eq.mock.calls).toEqual([['target_ref', scope.projectRef], ['project_id', scope.projectId], ['user_id', scope.ownerId], ['claim_token', args.p_claim_token]])
  })
  it('validates scope before RPC and fails closed on missing schema, lock conflict or malformed result', async () => {
    await expect(claimFunctionLease(client, { ...scope, ownerId: 'invalid' })).rejects.toThrow()
    expect(rpc).not.toHaveBeenCalled()
    rpc.mockResolvedValueOnce({ error: { message: 'private database details' } })
    await expect(claimFunctionLease(client, scope)).rejects.toThrow('migration 027')
    for (const data of [null, true, 'invalid-date']) {
      rpc.mockResolvedValueOnce({ data, error: null })
      await expect(claimFunctionLease(client, scope)).rejects.toThrow('outra publicação')
    }
  })
  it('rejects expired/replaced lease and does not expose DB errors during verification or release', async () => {
    const lease = await claimFunctionLease(client, scope)
    for (const result of [{ data: false, error: null }, { data: true, error: { message: 'private' } }]) {
      rpc.mockResolvedValueOnce(result)
      await expect(lease.assertCurrent()).rejects.toThrow('expirou')
    }
    eq.mockReturnValue({ eq, error: { message: 'private' } })
    await expect(lease.release()).rejects.toThrow('reserva não foi encerrada')
  })
  it('restricts table/RPCs to server role and validates owner, account, ref and provenance in the claim transaction', () => {
    const sql = readFileSync('supabase/migrations/027_function_operation_leases.sql', 'utf8')
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain('REVOKE ALL ON TABLE public.function_operation_leases FROM PUBLIC, anon, authenticated')
    expect(sql.match(/REVOKE ALL ON FUNCTION/g)).toHaveLength(2)
    expect(sql.match(/GRANT EXECUTE ON FUNCTION.*TO service_role/g)).toHaveLength(2)
    expect(sql).toContain('a.user_id=p.user_id'); expect(sql).toContain('p.user_id=p_user_id')
    expect(sql).toContain("e.source='supremo_provisioned'"); expect(sql).toContain('e.environment=p_environment')
    expect(sql).toContain('ON CONFLICT(target_ref) DO UPDATE')
    expect(sql).toContain('WHERE function_operation_leases.lease_expires_at<=clock_timestamp()')
    expect(sql).toContain("interval '2 minutes'"); expect(sql).toContain("interval '45 seconds'")
    expect(sql).toContain('l.claim_token=p_claim_token')
  })
})
