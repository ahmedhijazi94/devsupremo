import { fork, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http, { type IncomingHttpHeaders } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { previewHttpRecoveryScript } from './preview-http-recovery'

type Options = {
  environment?: 'production' | 'development' | 'test'
  enabled?: string
  processLimit?: string
  serverLimit?: number
  handler?: 'before' | 'after'
  expectationHandler?: 'checkContinue' | 'checkExpectation'
}
type Preview = { port: number; pid: number; log: () => string }
type Reply = { status: number; headers: IncomingHttpHeaders; body: string }

async function withPreview(options: Options, run: (preview: Preview) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'supremo-http-recovery-'))
  const preload = join(dir, 'recovery.cjs')
  const server = join(dir, 'server.cjs')
  writeFileSync(preload, previewHttpRecoveryScript())
  writeFileSync(server, `
    const http = require('node:http')
    let count = 0
    const options = JSON.parse(process.env.FIXTURE_OPTIONS)
    const app = http.createServer(options.serverLimit ? { maxHeaderSize: options.serverLimit } : {}, (req, res) => {
      count++
      req.resume()
      req.on('end', () => {
        res.setHeader('x-fixture-pid', String(process.pid))
        res.setHeader('x-cookie-bytes', String((req.headers.cookie || '').length))
        res.setHeader('x-header-limit', String(app.maxHeaderSize || http.maxHeaderSize))
        res.end(JSON.stringify({ pid: process.pid, count, path: req.url, cookie: req.headers.cookie || '' }))
      })
    })
    const onError = (error, socket) => socket.end('HTTP/1.1 422 Custom Handler\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n')
    if (options.handler === 'before') app.on('clientError', onError)
    if (options.expectationHandler) app.on(options.expectationHandler, (req, res) => {
      req.resume()
      if (options.expectationHandler === 'checkContinue') res.writeContinue()
      res.end('expectation handled')
    })
    app.listen(0, '127.0.0.1', () => {
      if (options.handler === 'after') app.on('clientError', onError)
      process.send({ port: app.address().port })
    })
  `)
  let child: ChildProcess | undefined
  let log = ''
  try {
    child = fork(server, [], {
      execArgv: ['--require', preload, ...(options.processLimit ? [options.processLimit] : [])],
      silent: true,
      env: {
        ...process.env,
        NODE_OPTIONS: '--max-http-header-size=65536',
        NODE_ENV: options.environment ?? 'development',
        SUPREMO_PREVIEW_HTTP_RECOVERY: options.enabled ?? '1',
        FIXTURE_OPTIONS: JSON.stringify(options),
      },
    })
    child.stderr?.on('data', (chunk: Buffer) => { log += chunk.toString() })
    const processChild = child
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Preview fixture startup timed out: ${log}`)), 3000)
      processChild.once('message', (message: { port: number }) => { clearTimeout(timer); resolve(message.port) })
      processChild.once('error', (error) => { clearTimeout(timer); reject(error) })
      processChild.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${log}`)) })
    })
    await run({ port, pid: child.pid!, log: () => log })
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
      child.kill('SIGTERM')
      await Promise.race([exited, pause(1000)])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

function request(port: number, options: { path?: string; method?: string; cookie?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: options.path ?? '/', method: options.method ?? 'GET',
      agent: false, timeout: 3000, headers: { cookie: options.cookie ?? '' },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.once('error', (error: NodeJS.ErrnoException) => {
      // Native rejection may close the socket before the oversized upload ends.
      // Positive recovery checks still require the actual 307 and subsequent 200.
      if (error.code === 'ECONNRESET') resolve({ status: 0, headers: {}, body: '' })
      else reject(error)
    })
    req.once('timeout', () => req.destroy(new Error('Fixture request timeout')))
    req.end()
  })
}

function openSocket(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

async function raw(port: number, chunks: string[], socket?: net.Socket): Promise<string> {
  const connection = socket ?? await openSocket(port)
  try {
    const response = new Promise<string>((resolve, reject) => {
      let received = ''
      connection.setTimeout(3000, () => connection.destroy(new Error('Raw fixture request timeout')))
      connection.on('data', (chunk: Buffer) => { received += chunk.toString('latin1') })
      connection.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNRESET' && received) resolve(received)
        else reject(error)
      })
      connection.once('close', () => resolve(received))
    })
    for (const [index, chunk] of chunks.entries()) {
      if (index) await pause(20)
      if (!connection.destroyed) connection.write(chunk)
    }
    return await response
  } finally {
    connection.destroy()
  }
}

const largeCookie = `session=${'x'.repeat(80 * 1024)}`
const overflowRequest = (target = '/app?filter=pending', method = 'GET'): string =>
  `${method} ${target} HTTP/1.1\r\nHost: localhost\r\nCookie: ${largeCookie}\r\nConnection: close\r\n\r\n`

describe('automatic local preview HTTP recovery — actual Node parser', () => {
  it.each(['GET', 'HEAD'])('%s: retries on a new connection, retaining the session and process', async (method) => {
    await withPreview({}, async ({ port, pid, log }) => {
      const first = await request(port, { method, path: '/app?filter=pending', cookie: largeCookie })
      expect(first.status).toBe(307)
      expect(first.headers.location).toBe('/app?filter=pending')
      expect(first.headers.connection).toBe('close')
      expect(first.headers['cache-control']).toBe('no-store')
      expect(first.headers['content-length']).toBe('0')
      const target = first.headers.location
      if (!target) throw new Error('Recovery did not return a redirect target')
      const retried = await request(port, { method, path: target, cookie: largeCookie })
      expect(retried.status).toBe(200)
      expect(retried.headers['x-fixture-pid']).toBe(String(pid))
      expect(retried.headers['x-cookie-bytes']).toBe(String(largeCookie.length))
      expect(retried.headers['x-header-limit']).toBe(String(128 * 1024))
      if (method === 'GET') {
        expect(JSON.parse(retried.body)).toMatchObject({ count: 1, cookie: largeCookie, path: '/app?filter=pending' })
      }
      expect(log()).not.toContain(largeCookie)
      expect(log()).not.toContain('/app?filter=pending')
    })
  })

  it('stops redirecting at the ceiling', async () => {
    await withPreview({}, async ({ port }) => {
      const tooLarge = `session=${'x'.repeat(140 * 1024)}`
      const first = await request(port, { cookie: tooLarge })
      expect(first.status).toBe(307)
      const second = await request(port, { cookie: tooLarge })
      expect([0, 431]).toContain(second.status)
      expect(second.headers.location).toBeUndefined()
      expect((await request(port)).headers['x-header-limit']).toBe(String(128 * 1024))
    })
  })

  it('does not replay POST or enlarge the limit for it', async () => {
    await withPreview({}, async ({ port }) => {
      const reply = await raw(port, [overflowRequest('/payments', 'POST')])
      expect(reply).toMatch(/^HTTP\/1\.1 431 /)
      expect(reply).not.toContain('Location:')
      const normal = await request(port)
      expect(JSON.parse(normal.body).count).toBe(1)
      expect(normal.headers['x-header-limit']).toBe(String(64 * 1024))
    })
  })

  it.each(['pipelined', 'keepalive'])('does not replay a later %s request using an earlier target', async (mode) => {
    await withPreview({}, async ({ port }) => {
      const first = 'GET /first HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n'
      const second = overflowRequest('/second')
      const reply = await raw(port, mode === 'pipelined' ? [first + second] : [first, second])
      expect(reply).not.toContain('307')
      expect(reply).not.toContain('Location:')
      expect(reply).toContain('431')
      expect((await request(port)).headers['x-header-limit']).toBe(String(64 * 1024))
    })
  })

  it.each([
    { expectationHandler: 'checkContinue', mode: 'keepalive' },
    { expectationHandler: 'checkContinue', mode: 'pipelined' },
    { expectationHandler: 'checkExpectation', mode: 'keepalive' },
    { expectationHandler: 'checkExpectation', mode: 'pipelined' },
  ] as const)('does not replay a $mode mutation after a custom $expectationHandler response', async ({ expectationHandler, mode }) => {
    await withPreview({ expectationHandler }, async ({ port }) => {
      const expectation = expectationHandler === 'checkContinue' ? '100-continue' : 'preview-unsupported'
      const first = `GET /first HTTP/1.1\r\nHost: localhost\r\nExpect: ${expectation}\r\nConnection: keep-alive\r\n\r\n`
      const second = overflowRequest('/payments', 'POST')
      const reply = await raw(port, mode === 'pipelined' ? [first + second] : [first, second])
      expect(reply).toContain('expectation handled')
      expect(reply).not.toContain('307')
      expect(reply).not.toContain('Location:')
      expect(reply).toContain('431')
      const normal = await request(port)
      expect(JSON.parse(normal.body).count).toBe(1)
      expect(normal.headers['x-header-limit']).toBe(String(64 * 1024))
    })
  })

  it.each(['keepalive', 'pipelined'])('does not replay a %s mutation after the default unsupported Expect response', async (mode) => {
    await withPreview({}, async ({ port }) => {
      const first = 'GET /first HTTP/1.1\r\nHost: localhost\r\nExpect: preview-unsupported\r\nConnection: keep-alive\r\n\r\n'
      const second = overflowRequest('/payments', 'POST')
      const reply = await raw(port, mode === 'pipelined' ? [first + second] : [first, second])
      expect(reply).toContain('417')
      expect(reply).not.toContain('307')
      expect(reply).not.toContain('Location:')
      expect(reply).toContain('431')
      const normal = await request(port)
      expect(JSON.parse(normal.body).count).toBe(1)
      expect(normal.headers['x-header-limit']).toBe(String(64 * 1024))
    })
  })

  it('rejects dangerous or unbounded redirect targets', async () => {
    await withPreview({}, async ({ port }) => {
      for (const target of ['//evil.example/a', '/\\evil.example/a', 'http://evil.example/a', `/${'a'.repeat(2100)}`, '/bad\x7fpath']) {
        const reply = await raw(port, [overflowRequest(target)])
        expect(reply).not.toContain('307')
        expect(reply).not.toContain('Location:')
        expect(reply).toMatch(/^HTTP\/1\.1 (?:400|431) /)
      }
      expect((await request(port)).headers['x-header-limit']).toBe(String(64 * 1024))
    })
  })

  it('captures a fragmented initial request line and forgets all header contents', async () => {
    await withPreview({}, async ({ port, log }) => {
      const reply = await raw(port, ['GE', 'T /app?tab=all HT', `TP/1.1\r\nHost: localhost\r\nCookie: ${largeCookie}\r\n\r\n`])
      expect(reply).toMatch(/^HTTP\/1\.1 307 /)
      expect(reply).toContain('Location: /app?tab=all\r\n')
      expect(log()).not.toContain('session=')
      expect(log()).not.toContain('tab=all')
    })
  })

  it('handles two parsers created before the first connection upgrades capacity', async () => {
    await withPreview({}, async ({ port }) => {
      const firstSocket = await openSocket(port)
      const secondSocket = await openSocket(port)
      try {
        expect(await raw(port, [overflowRequest('/first')], firstSocket)).toContain('307')
        expect(await raw(port, [overflowRequest('/second')], secondSocket)).toContain('307')
        expect((await request(port, { cookie: largeCookie })).status).toBe(200)
      } finally {
        firstSocket.destroy()
        secondSocket.destroy()
      }
    })
  })

  it.each(['before', 'after'] as const)('preserves a custom clientError handler installed %s listen', async (handler) => {
    await withPreview({ handler }, async ({ port }) => {
      expect((await request(port, { cookie: largeCookie })).status).toBe(422)
      expect((await request(port)).headers['x-header-limit']).toBe(String(64 * 1024))
    })
  })

  it('preserves the default response to malformed HTTP', async () => {
    await withPreview({}, async ({ port }) => {
      const reply = await raw(port, ['G?T / HTTP/1.1\r\nHost: localhost\r\n\r\n'])
      expect(reply).toMatch(/^HTTP\/1\.1 400 /)
      expect((await request(port)).headers['x-header-limit']).toBe(String(64 * 1024))
    })
  })

  it.each([
    { label: 'server explicitly configured', serverLimit: 32 * 1024, limit: 32 * 1024 },
    { label: 'process explicitly configured', processLimit: '--max-http-header-size=32768', limit: 32 * 1024 },
    { label: 'production', environment: 'production', limit: 64 * 1024 },
    { label: 'feature disabled', enabled: '0', limit: 64 * 1024 },
  ] as const)('$label: leaves the original limit and rejection intact', async (options) => {
    await withPreview(options, async ({ port }) => {
      const reply = await request(port, { cookie: largeCookie })
      expect([0, 431]).toContain(reply.status)
      expect(reply.headers.location).toBeUndefined()
      expect((await request(port)).headers['x-header-limit']).toBe(String(options.limit))
    })
  })
})
