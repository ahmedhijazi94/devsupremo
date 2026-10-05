import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { authorizeRuntimeUpdate, officialRuntimeCandidate } from './runtime-update-authority'

const projectId = '11111111-1111-4111-8111-111111111111'
const otherProject = '22222222-2222-4222-8222-222222222222'
const revision = '33333333-3333-4333-8333-333333333333'
const issuer = 'https://supremo.example.invalid/installation'
const credential = 'fixture-device-authorization-only'
let storedIdentity: string
let configuredIssuer: string
vi.mock('./daemon', () => ({ readProjectConfig: () => ({ projectId, apiBaseUrl: configuredIssuer }) }))
vi.mock('./keychain', () => ({ resolveKeychain: () => ({ get: () => storedIdentity }) }))
const candidate = { projectId, revision, cliDigest: 'a'.repeat(64), templateVersion: '1.0.0', baseSha: 'b'.repeat(40), files: [] }
beforeEach(() => {
  configuredIssuer = `${issuer}/`
  storedIdentity = JSON.stringify({ version: 1, projectId, issuer, secret: credential })
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { operation: string }
    return Response.json(body.operation === 'prepare' ? candidate : { projectId, revision })
  }))
})
afterEach(() => vi.unstubAllGlobals())

it('binds the candidate and authorization requests to the same canonical keychain issuer', async () => {
  expect(await officialRuntimeCandidate(projectId, `${issuer}/`)).toEqual(candidate)
  await authorizeRuntimeUpdate('/fixture', { projectId, issuer, revision })
  const calls = vi.mocked(fetch).mock.calls
  expect(calls.map(call => call[0])).toEqual([`${issuer}/api/cli/candidate`, `${issuer}/api/cli/candidate`])
  expect(calls.map(call => JSON.parse(String(call[1]?.body)) as unknown)).toEqual([
    { projectId, deviceSecret: credential, operation: 'prepare' },
    { projectId, deviceSecret: credential, operation: 'authorize' },
  ])
  expect(calls.every(call => call[1]?.redirect === 'error')).toBe(true)
})

it.each(['https://attacker.example.invalid', 'https://supremo.example.invalid/other-installation'])('refuses the unbound issuer %s without sending credentials', async destination => {
  await expect(officialRuntimeCandidate(projectId, destination)).rejects.toThrow('Origem')
  expect(fetch).not.toHaveBeenCalled()
})

it('rejects file-derived identities and authorities outside the explicit selector contract', async () => {
  await expect(officialRuntimeCandidate('arbitrary local file content', issuer)).rejects.toThrow()
  await expect(authorizeRuntimeUpdate('/fixture', { projectId, issuer, revision, content: 'unexpected local data' } as never)).rejects.toThrow()
  expect(fetch).not.toHaveBeenCalled()
})

it('rejects a changed local installation before reauthorizing prepared tools', async () => {
  configuredIssuer = 'https://attacker.example.invalid'
  await expect(authorizeRuntimeUpdate('/fixture', { projectId, issuer, revision })).rejects.toThrow('Identidade local mudou')
  expect(fetch).not.toHaveBeenCalled()
})

it('rejects a candidate or revision belonging to a different authorization', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ...candidate, projectId: otherProject }))
  await expect(officialRuntimeCandidate(projectId, issuer)).rejects.toThrow('outro projeto')
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ projectId, revision: otherProject }))
  await expect(authorizeRuntimeUpdate('/fixture', { projectId, issuer, revision })).rejects.toThrow('autorização mudou')
})
