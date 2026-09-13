/** Preload exclusivo do preview local. Nunca limpa cookies ou altera o app. */
export function previewHttpRecoveryScript(): string {
  return String.raw`'use strict'
const http = require('node:http')
const installed = Symbol.for('supremo.preview.http-recovery')
const explicitLimit = /--max[-_]http[-_]header[-_]size(?:=|$)/
const CEILING = 128 * 1024

if (process.env.SUPREMO_PREVIEW_HTTP_RECOVERY === '1'
    && process.env.NODE_ENV === 'development'
    && !process.execArgv.some((arg) => explicitLimit.test(arg))
    && !http.Server.prototype[installed]) {
  Object.defineProperty(http.Server.prototype, installed, { value: true })
  const listen = http.Server.prototype.listen
  const servers = new WeakSet()
  http.Server.prototype.listen = function (...args) {
    // Uma configuração explícita do próprio app sempre vence.
    if (!servers.has(this) && this.maxHeaderSize == null) {
      servers.add(this)
      protect(this)
    }
    return Reflect.apply(listen, this, args)
  }
}

function protect(server) {
  const connections = new WeakMap()
  let managedLimit = server.maxHeaderSize
  // Depois do listener interno do Node: adicionar data aqui desativa o parser
  // que consome o socket diretamente, permitindo capturar a linha antes dele.
  server.on('connection', (socket) => {
    const state = { limit: server.maxHeaderSize || http.maxHeaderSize, line: '', target: null, first: true }
    connections.set(socket, state)
    // Só a primeira linha, no máximo 2 KiB. Não guarda headers, cookies ou body.
    function capture(chunk) {
      const end = chunk.indexOf(10)
      const size = end < 0 ? chunk.length : end + 1
      if (state.line.length + size > 2048) { forget(); return }
      state.line += chunk.subarray(0, size).toString('latin1')
      if (end < 0) return
      const match = /^(?:GET|HEAD) (\/[^\s\\]*) HTTP\/1\.[01]\r\n$/.exec(state.line)
      if (match && !match[1].startsWith('//') && !/[\x00-\x20\x7f]/.test(match[1])) state.target = match[1]
      forget()
    }
    function forget() {
      state.line = ''
      socket.removeListener('data', capture)
    }
    state.forget = forget
    socket.prependListener('data', capture)
  })
  const emit = server.emit
  server.emit = function (event, ...args) {
    if (['request', 'upgrade', 'connect', 'checkContinue', 'checkExpectation', 'dropRequest'].includes(event)) {
      const state = connections.get(args[0].socket)
      if (state) { state.first = false; state.target = null; state.forget() }
    }
    if (event === 'clientError' && server.listenerCount('clientError') === 0) {
      const [error, socket] = args
      const state = connections.get(socket)
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socket.remoteAddress)
      // Intercepta só a navegação inicial comprovada. Não repete mutações,
      // requests em keepalive nem erros com handler próprio do aplicativo.
      // bytesWritten também cobre respostas nativas (ex.: 417) sem evento request.
      if (error.code === 'HPE_HEADER_OVERFLOW' && local && state?.first
          && state.target && socket.writable && !socket.destroyed && socket.bytesWritten === 0
          && server.maxHeaderSize === managedLimit && state.limit < CEILING) {
        if ((server.maxHeaderSize || http.maxHeaderSize) < CEILING) {
          server.maxHeaderSize = CEILING
          managedLimit = CEILING
          // Sem URL, conteúdo dos headers ou valores de sessão no diagnóstico.
          process.stderr.write('[Supremo preview] Excesso de headers locais detectado; capacidade ajustada para 128 KiB, preservando as sessões.\n')
        }
        const target = state.target
        state.first = false
        state.target = null
        state.forget()
        socket.end('HTTP/1.1 307 Temporary Redirect\r\nLocation: ' + target
          + '\r\nCache-Control: no-store\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
        return true
      }
    }
    // Retornar o emit original preserva o 431/400 e o fechamento padrão do Node.
    // Um listener clientError vazio desabilitaria essas proteções.
    return Reflect.apply(emit, this, [event, ...args])
  }
}
`
}
