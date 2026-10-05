import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runDatabaseDirect } from './database'

const projectId = '11111111-1111-4111-8111-111111111111'
const issuer = 'https://supremo.example.invalid'
const limit = 2 * 1024 * 1024
vi.mock('./daemon', () => ({ readProjectConfig: () => ({ projectId, apiBaseUrl: issuer }) }))
vi.mock('./keychain', () => ({ resolveKeychain: () => ({ get: () => JSON.stringify({ version: 1, projectId, issuer, secret: 'fixture-authorization' }) }) }))
let cwd: string
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-database-response-'))
  fs.mkdirSync(path.join(cwd, '.supremo'))
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); fs.rmSync(cwd, { recursive: true, force: true }) })

it('accepts exactly 2 MiB and preserves UTF-8 split across response chunks', async () => {
  const payload = { value: `é${'x'.repeat(limit - Buffer.byteLength(JSON.stringify({ value: 'é' })))}` }
  const bytes = Buffer.from(JSON.stringify(payload))
  const split = bytes.indexOf(Buffer.from('é')) + 1
  expect(bytes.byteLength).toBe(limit)
  vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, split))
      controller.enqueue(bytes.subarray(split))
      controller.close()
    },
  })))
  expect(await runDatabaseDirect('status', cwd)).toEqual(payload)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it.each(['single-chunk', 'multiple-chunks', 'multibyte'] as const)('stops and cancels an oversized %s response before reading its remainder', async variant => {
  const chunks = variant === 'single-chunk' ? [new Uint8Array(limit + 1)]
    : variant === 'multibyte' ? [Buffer.from('é'.repeat(limit / 2 + 1))]
      : [new Uint8Array(limit), new Uint8Array(1)]
  let reads = 0
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++
      controller.enqueue(chunks[reads - 1] ?? new Uint8Array(1))
    },
    cancel,
  }, { highWaterMark: 0 })
  vi.mocked(fetch).mockResolvedValue(new Response(body))
  await expect(runDatabaseDirect('status', cwd)).rejects.toThrow('excede o limite')
  expect(reads).toBe(chunks.length)
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(body.locked).toBe(false)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fs.existsSync(path.join(cwd, '.supremo/database.json'))).toBe(false)
})

it.each(['reject', 'hang'] as const)('does not wait for or replace the size error when stream cancellation can %s', async cancellation => {
  const cancel = vi.fn(() => cancellation === 'reject'
    ? Promise.reject(new Error('provider cancellation failed'))
    : new Promise<void>(() => undefined))
  vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(limit + 1)) }, cancel,
  })))
  await expect(runDatabaseDirect('status', cwd)).rejects.toThrow('excede o limite')
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it.each(['error', 'truncated'] as const)('rejects a %s body without publishing a snapshot or retrying', async failure => {
  let reads = 0
  vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(Buffer.from('{"environment":'))
      else if (failure === 'error') controller.error(new Error('provider body failed'))
      else controller.close()
    },
  }, { highWaterMark: 0 })))
  await expect(runDatabaseDirect('status', cwd)).rejects.toThrow()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fs.existsSync(path.join(cwd, '.supremo/database.json'))).toBe(false)
})

it('cancels a stalled body when the existing status timeout signal aborts', async () => {
  const controller = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
  const cancel = vi.fn()
  let requested!: () => void
  const reading = new Promise<void>(resolve => { requested = resolve })
  const body = new ReadableStream<Uint8Array>({ pull() { requested() }, cancel }, { highWaterMark: 0 })
  vi.mocked(fetch).mockResolvedValue(new Response(body))
  const result = runDatabaseDirect('status', cwd).catch((error: unknown) => error)
  await reading
  controller.abort(new Error('status deadline elapsed'))
  expect(await result).toMatchObject({ message: 'status deadline elapsed' })
  expect(timeout).toHaveBeenCalledWith(15_000)
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(body.locked).toBe(false)
  expect(fetch).toHaveBeenCalledTimes(1)
})
