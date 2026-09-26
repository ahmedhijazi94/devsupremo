import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduledFunctionNames } from './function-contract'
import { supabaseJobsProvider } from './provider'

const projectId = '00000000-0000-4000-8000-000000000001'
const credentials = { projectRef: 'project-fixture', token: 'private-provider-fixture' }
const secret = 'a'.repeat(64)
const row = { name: scheduledFunctionNames(projectId, 'daily-report').environment,
  value: createHash('sha256').update(secret).digest('hex'), updated_at: '2026-09-26T12:00:00Z' }
afterEach(() => vi.unstubAllGlobals())

describe('cron signing secret response confirmation', () => {
  it.each(['duplicate', 'conflicting-alias', 'plaintext', 'missing-value'] as const)('refuses %s before installing or probing credentials', async kind => {
    const metadata = kind === 'duplicate' ? [row, row] : kind === 'conflicting-alias' ? [{ ...row, digest: 'f'.repeat(64) }]
      : kind === 'plaintext' ? [{ ...row, value: 'private-secret-never' }] : [{ name: row.name, digest: row.value }]
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json([{ secret }])).mockResolvedValueOnce(Response.json(metadata))
    vi.stubGlobal('fetch', fetcher)
    const error: unknown = await supabaseJobsProvider(async () => credentials).prepareFunctionSigner!(projectId, 'daily-report').catch((reason: unknown) => reason)
    expect(error).toMatchObject({ status: 502, message: 'Metadados de segredo cron inválidos.' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(String(error)).not.toContain('private-secret-never')
  })

  it.each(['missing', 'changed', 'duplicated', 'malformed'] as const)('does not certify %s final metadata despite passing all HMAC probes', async kind => {
    const metadata = kind === 'missing' ? [] : kind === 'changed' ? [{ ...row, value: 'f'.repeat(64) }]
      : kind === 'duplicated' ? [row, row] : [{ ...row, value: 'private-secret-never' }]
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json([{ secret }])).mockResolvedValueOnce(Response.json([row]))
      .mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json(metadata))
    const resolve = vi.fn(async () => credentials)
    vi.stubGlobal('fetch', fetcher)
    await expect(supabaseJobsProvider(resolve).prepareFunctionSigner!(projectId, 'daily-report')).rejects.toMatchObject({ status: 502, message: expect.stringContaining('leitura final') })
    expect(fetcher).toHaveBeenCalledTimes(7)
    expect(resolve).toHaveBeenLastCalledWith(true)
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe('https://api.supabase.com/v1/projects/project-fixture/secrets')
  })

  it('reauthorizes the final read and propagates revocation without retrying or returning success', async () => {
    const resolve = vi.fn(async () => credentials)
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json([{ secret }])).mockResolvedValueOnce(Response.json([row]))
      .mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 })).mockImplementationOnce(async () => {
        resolve.mockRejectedValueOnce(new Error('Dispositivo revogado.'))
        return new Response(null, { status: 204 })
      })
    vi.stubGlobal('fetch', fetcher)
    await expect(supabaseJobsProvider(resolve).prepareFunctionSigner!(projectId, 'daily-report')).rejects.toThrow('revogado')
    expect(fetcher).toHaveBeenCalledTimes(6)
  })
})
