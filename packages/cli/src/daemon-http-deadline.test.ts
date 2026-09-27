import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultDaemonHttp, NetworkError, PublishTimeoutError, SYNC_STATUS_TIMEOUT_MS, type PublishInput } from './daemon'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('prazo independente do cancelamento HTTP', () => {
  const input = { deviceSecret: 'device-test', projectId: 'project-test' }

  it.each(['headers', 'body'] as const)('libera a fila se o transporte ignora abort em %s', async (phase) => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    let finish!: (value: unknown) => void
    const stalled = new Promise(resolve => { finish = resolve })
    const fetch = vi.fn((_url: string, options: RequestInit) => {
      signal = options.signal ?? undefined
      return phase === 'headers' ? stalled : Promise.resolve({ ok: true, status: 200, json: () => stalled })
    })
    vi.stubGlobal('fetch', fetch)
    const client = defaultDaemonHttp('https://supremo.test')
    const first = expect(client.pollRestores(input)).rejects.toBeInstanceOf(NetworkError)
    await vi.advanceTimersByTimeAsync(SYNC_STATUS_TIMEOUT_MS)
    await first
    expect(signal?.aborted).toBe(true)
    // An old response arriving later has no effect on the next request.
    finish(phase === 'headers'
      ? { ok: true, status: 200, json: async () => ({ requests: [{ restoreRequestId: 'stale' }] }) }
      : { requests: [{ restoreRequestId: 'stale' }] })
    fetch.mockImplementationOnce(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ requests: [] }) }))
    await expect(client.pollRestores(input)).resolves.toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('mantém timeout de publicação distinto e permite retry do mesmo pedido', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const client = defaultDaemonHttp('https://supremo.test', { publishTimeoutMs: 80 })
    const pending = expect(client.publish(input as PublishInput)).rejects.toBeInstanceOf(PublishTimeoutError)
    await vi.advanceTimersByTimeAsync(80)
    await pending
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('encerra sem esperar a rede quando stop já ocorreu: %s', async (alreadyStopped) => {
    const controller = new AbortController()
    const fetch = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetch)
    if (alreadyStopped) controller.abort()
    const client = defaultDaemonHttp('https://supremo.test', { signal: controller.signal })
    const pending = expect(client.pollRestores(input)).rejects.toBeInstanceOf(NetworkError)
    controller.abort()
    await pending
    expect(fetch).toHaveBeenCalledTimes(alreadyStopped ? 0 : 1)
  })
})
