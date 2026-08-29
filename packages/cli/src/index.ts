#!/usr/bin/env node
/**
 * Ponte stdio → HTTP para o MCP do Supremo.
 *
 * Existe só para clientes que ainda não falam MCP remoto. Ela é um proxy
 * transparente de JSON-RPC: não conhece nenhuma ferramenta, não tem lógica
 * de negócio, e nada sensível mora aqui. O servidor continua sendo a única
 * fonte da verdade — inclusive da lista de ferramentas, que por isso nunca
 * sai de sincronia com o Supremo.
 *
 * Configuração:
 *   SUPREMO_URL    endpoint MCP (padrão: https://supremo.app/api/mcp)
 *   SUPREMO_TOKEN  token pessoal gerado em /mcps
 */

import { createInterface } from 'node:readline'

const DEFAULT_URL = 'https://supremo.app/api/mcp'

const endpoint = process.env.SUPREMO_URL ?? DEFAULT_URL
const token = process.env.SUPREMO_TOKEN

function logStderr(message: string): void {
  process.stderr.write(`[supremo] ${message}\n`)
}

if (!token) {
  logStderr(
    'SUPREMO_TOKEN não definido. Gere um token em /mcps e exporte-o antes de rodar a ponte.'
  )
  process.exit(1)
}

/** Erro de JSON-RPC devolvido ao cliente, preservando o id da requisição. */
function protocolError(
  id: unknown,
  code: number,
  message: string
): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function write(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

async function forward(message: Record<string, unknown>): Promise<void> {
  const id = message.id

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(message),
    })

    // Notificações não têm id e não esperam resposta.
    if (id === undefined) return

    if (response.status === 401) {
      write(
        protocolError(
          id,
          -32001,
          'Token do Supremo inválido, revogado ou expirado. Gere outro em /mcps.'
        )
      )
      return
    }

    const body = await response.text()

    if (!response.ok) {
      write(
        protocolError(
          id,
          -32603,
          `Supremo respondeu ${response.status}: ${body.slice(0, 400)}`
        )
      )
      return
    }

    if (!body.trim()) return

    // O endpoint pode responder JSON puro ou um frame SSE.
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      for (const line of body.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('data:')) {
          const data = trimmed.slice(5).trim()
          if (data) process.stdout.write(`${data}\n`)
        }
      }
      return
    }

    process.stdout.write(`${body.trim()}\n`)
  } catch (error) {
    if (id === undefined) return
    write(
      protocolError(
        id,
        -32603,
        `Falha ao falar com o Supremo em ${endpoint}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    )
  }
}

function main(): void {
  const rl = createInterface({ input: process.stdin, terminal: false })

  // Requisições são encaminhadas em ordem de chegada; o await em série
  // preserva a ordem das respostas, que alguns clientes assumem.
  let queue: Promise<void> = Promise.resolve()

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return

    let message: Record<string, unknown>
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      write(protocolError(null, -32700, 'JSON inválido recebido via stdin.'))
      return
    }

    queue = queue.then(() => forward(message))
  })

  rl.on('close', () => {
    void queue.then(() => process.exit(0))
  })

  logStderr(`ponte ativa → ${endpoint}`)
}

main()
