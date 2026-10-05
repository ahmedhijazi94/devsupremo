import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireProjectOwner: vi.fn(), requireUser: vi.fn(), completeOAuthConnection: vi.fn(), createServiceClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', () => ({ requireProjectOwner: mocks.requireProjectOwner, requireUser: mocks.requireUser }))
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: mocks.createServiceClient }))
vi.mock('@/lib/provider-connections/oauth-server', () => ({ completeOAuthConnection: mocks.completeOAuthConnection, oauthCallbackUrl: () => 'https://supremo.example.com/auth/provider/callback' }))
import { GET } from './route'
const projectId = '11111111-1111-4111-8111-111111111111', state = `${projectId}.${'a'.repeat(43)}`
beforeEach(() => { vi.clearAllMocks(); mocks.requireProjectOwner.mockResolvedValue({ user: { id: projectId } }); mocks.requireUser.mockResolvedValue({ user: { id: projectId } }); mocks.completeOAuthConnection.mockResolvedValue({ verified: true }) })
describe('project OAuth callback boundary', () => {
  it('requires an owner cookie, consumes the validated state and redirects only to the configured application', async () => {
    const response = await GET(new Request(`https://attacker-origin.example.com/auth/provider/callback?state=${state}&code=private-code`))
    expect(mocks.requireProjectOwner).toHaveBeenCalledWith(projectId, 'id,user_id')
    expect(mocks.completeOAuthConnection).toHaveBeenCalledWith(expect.objectContaining({ ownerId: projectId, projectId }), { state, code: 'private-code' })
    expect(response.headers.get('Location')).toBe(`https://supremo.example.com/projects/${projectId}?oauth=connected`)
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
  it('rejects a device-style callback without owner authentication before touching OAuth', async () => {
    mocks.requireProjectOwner.mockRejectedValue(new Error('not owner'))
    const response = await GET(new Request(`https://supremo.example.com/auth/provider/callback?state=${state}&code=private-code`))
    expect(mocks.createServiceClient).not.toHaveBeenCalled()
    expect(mocks.completeOAuthConnection).not.toHaveBeenCalled()
    expect(response.headers.get('Location')).not.toMatch(/private-code|state=/)
  })
  it.each([`state=${state}&code=one&code=two`, `state=${state}&error=denied`, 'state=forged&code=code'])( 'rejects ambiguous or invalid callback %s', async query => {
    const response = await GET(new Request(`https://supremo.example.com/auth/provider/callback?${query}`))
    expect(mocks.completeOAuthConnection).not.toHaveBeenCalled()
    expect(response.headers.get('Location')).toBe('https://supremo.example.com/projects?oauth=not-confirmed')
  })
  it('never surfaces a provider error body or transient authorization code', async () => {
    mocks.completeOAuthConnection.mockRejectedValue(new Error('secret token body'))
    const response = await GET(new Request(`https://supremo.example.com/auth/provider/callback?state=${state}&code=private-code`))
    expect(await response.text()).toBe('')
    expect(JSON.stringify([...response.headers])).not.toMatch(/secret|private-code|state=/)
  })
})
