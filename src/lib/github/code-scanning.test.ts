import { describe, expect, it, vi } from 'vitest'
import { evaluateCodeScanning, readCodeScanning, type CodeScanningCheck, type CodeScanningPort } from './code-scanning'

const SHA = 'a'.repeat(40)
const official = (over: Partial<CodeScanningCheck> = {}): CodeScanningCheck => ({
  id: 10, name: 'CodeQL', head_sha: SHA, status: 'completed', conclusion: 'success',
  app: { id: 57789, slug: 'github-advanced-security', owner: { login: 'github' } }, ...over,
})
const port = (): CodeScanningPort => ({
  listChecks: vi.fn(async () => [official()]),
  getDefaultSetup: vi.fn(async () => ({ state: 'configured' })),
  getRepository: vi.fn(async () => ({ private: true, security_and_analysis: {
    code_security: { status: 'disabled' }, advanced_security: { status: 'disabled' },
  } })),
})

describe('independent official CodeQL gate', () => {
  it('accepts exact-head official success and waits when configured but absent', () => {
    expect(evaluateCodeScanning(SHA, [official()], 'configured').status).toBe('passed')
    expect(evaluateCodeScanning(SHA, [], 'configured').status).toBe('pending')
  })
  it('rejects forged publisher, name, owner and obsolete revision as CodeQL evidence', () => {
    for (const check of [official({ app: null }), official({ app: { id: 57789, slug: 'github-advanced-security', owner: null } }), official({ app: { id: 1, slug: 'github-advanced-security', owner: { login: 'github' } } }),
      official({ app: { id: 57789, slug: 'fake', owner: { login: 'github' } } }),
      official({ app: { id: 57789, slug: 'github-advanced-security', owner: { login: 'attacker' } } }),
      official({ head_sha: 'b'.repeat(40) }), official({ name: 'Build de produção' })]) {
      expect(evaluateCodeScanning(SHA, [check], 'configured').status).toBe('pending')
    }
  })
  it.each(['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', null])('never treats conclusion %s as approval', conclusion => {
    expect(evaluateCodeScanning(SHA, [official({ conclusion })], 'not-configured').status).toBe('failed')
  })
  it('selects the newest official attempt without allowing a fake newer run to hide it', () => {
    const pending = official({ id: 11, status: 'in_progress', conclusion: null })
    const forged = official({ id: 99, app: { id: 1 } })
    expect(evaluateCodeScanning(SHA, [forged, official(), pending], 'configured').status).toBe('pending')
    expect(evaluateCodeScanning(SHA, [official({ id: 8, conclusion: 'failure' }), official()], 'configured').status).toBe('passed')
    expect(evaluateCodeScanning(SHA, [official(), official({ id: 12, conclusion: 'failure' })], 'configured').status).toBe('failed')
  })
  it('requires positively confirmed configuration even after an official success', () => {
    expect(evaluateCodeScanning(SHA, [official()], 'unavailable').status).toBe('unavailable')
    expect(evaluateCodeScanning(SHA, [], 'not-configured').status).toBe('not_required')
  })
  it('consults the immutable revision and does not query license metadata normally', async () => {
    const io = port()
    expect((await readCodeScanning(io, SHA)).status).toBe('passed')
    expect(io.listChecks).toHaveBeenCalledWith(SHA)
    expect(io.getRepository).not.toHaveBeenCalled()
  })
  it.each([403, 404])('only waives unavailable CodeQL on HTTP %s with explicit private disabled feature proof', async status => {
    const io = port()
    vi.mocked(io.listChecks).mockResolvedValue([])
    vi.mocked(io.getDefaultSetup).mockRejectedValue({ status })
    const evidence = await readCodeScanning(io, SHA)
    expect(evidence.status).toBe('not_required')
    expect(evidence.reasons.join(' ')).toContain('privado')
    vi.mocked(io.listChecks).mockResolvedValue([official({ conclusion: 'failure' })])
    expect((await readCodeScanning(io, SHA)).status).toBe('failed')
  })
  it('never infers a license exception from 403/404, owner type, missing feature metadata or one disabled product', async () => {
    for (const repo of [{ private: true }, { private: false, security_and_analysis: { code_security: { status: 'disabled' }, advanced_security: { status: 'disabled' } } },
      { private: true, security_and_analysis: { advanced_security: { status: 'disabled' } } },
      { private: true, security_and_analysis: { code_security: { status: 'enabled' }, advanced_security: { status: 'disabled' } } },
      { private: true, security_and_analysis: { code_security: { status: 'disabled' }, advanced_security: { status: 'enabled' } } }]) {
      const io = port()
      vi.mocked(io.getDefaultSetup).mockRejectedValue({ status: 404 })
      vi.mocked(io.getRepository).mockResolvedValue(repo)
      expect((await readCodeScanning(io, SHA)).status).toBe('unavailable')
    }
  })
  it('accepts the current private repository response only with explicit disabled Code Security and its exact HTTP 403 refusal', async () => {
    const io = port()
    vi.mocked(io.listChecks).mockResolvedValue([])
    vi.mocked(io.getRepository).mockResolvedValue({ private: true, security_and_analysis: { code_security: { status: 'disabled' } } })
    vi.mocked(io.getDefaultSetup).mockRejectedValue({ status: 403, response: { data: {
      message: 'Code Security must be enabled for this repository to use code scanning.',
    } } })
    const evidence = await readCodeScanning(io, SHA)
    expect(evidence).toMatchObject({ headSha: SHA, status: 'not_required' })
    expect(evidence.reasons.join(' ')).toContain('não é aprovação do CodeQL')
    vi.mocked(io.listChecks).mockResolvedValue([official({ status: 'in_progress', conclusion: null })])
    expect((await readCodeScanning(io, SHA)).status).toBe('pending')
    vi.mocked(io.listChecks).mockResolvedValue([official({ conclusion: 'failure' })])
    expect((await readCodeScanning(io, SHA)).status).toBe('failed')
  })
  it('never treats missing modern license fields, a generic refusal or contradictory enabled metadata as an exception', async () => {
    const disabled = { private: true, security_and_analysis: { code_security: { status: 'disabled' } } }
    const refusal = { status: 403, message: 'Code Security must be enabled for this repository to use code scanning.' }
    for (const [error, repo] of [
      [{ status: 403, message: 'Forbidden' }, disabled], [{ ...refusal, status: 404 }, disabled],
      [refusal, { private: true }], [refusal, { ...disabled, private: false }],
      [refusal, { private: true, security_and_analysis: { code_security: { status: 'enabled' } } }],
      [refusal, { private: true, security_and_analysis: { code_security: { status: 'disabled' }, advanced_security: { status: 'enabled' } } }],
    ] as const) {
      const io = port()
      vi.mocked(io.listChecks).mockResolvedValue([])
      vi.mocked(io.getDefaultSetup).mockRejectedValue(error)
      vi.mocked(io.getRepository).mockResolvedValue(repo)
      expect((await readCodeScanning(io, SHA)).status).toBe('unavailable')
    }
  })
  it('reports checks, metadata, unknown configuration and network failures as unavailable', async () => {
    const io = port()
    vi.mocked(io.listChecks).mockRejectedValueOnce(new Error('offline'))
    expect((await readCodeScanning(io, SHA)).status).toBe('unavailable')
    vi.mocked(io.getDefaultSetup).mockResolvedValueOnce({ state: 'unknown' }).mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce({ status: 503 }).mockRejectedValueOnce({ status: 403 })
    vi.mocked(io.getRepository).mockRejectedValue(new Error('forbidden'))
    for (let i = 0; i < 4; i++) expect((await readCodeScanning(io, SHA)).status).toBe('unavailable')
  })
})
