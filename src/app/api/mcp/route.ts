import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createSupremoMcpServer } from '@/lib/mcp/server'
import { parseAuthorizationHeader, resolveMcpToken } from '@/lib/mcp/tokens'

/**
 * Endpoint MCP remoto do Supremo — transporte Streamable HTTP.
 *
 * É isto que tira o MCP da máquina do usuário: qualquer cliente, de qualquer
 * computador, conecta com um token pessoal e opera só os próprios projetos.
 *
 *   claude mcp add --transport http supremo https://SEU_APP/api/mcp \
 *     --header "Authorization: Bearer sup_…"
 *
 * Modo stateless: cada requisição monta o seu próprio transporte e servidor.
 * É o que funciona em ambiente serverless, onde não há memória compartilhada
 * entre invocações.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const WWW_AUTHENTICATE =
  'Bearer realm="supremo", error="invalid_token", ' +
  'error_description="Token de MCP ausente ou inválido"'

function unauthorized(detail: string): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      error: { code: -32001, message: detail },
      id: null,
    },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': WWW_AUTHENTICATE,
        'Cache-Control': 'no-store',
      },
    },
  )
}

async function authenticate(
  request: Request,
): Promise<{ userId: string } | Response> {
  const token = parseAuthorizationHeader(request.headers.get('authorization'))

  if (!token) {
    return unauthorized(
      'Envie o header Authorization: Bearer sup_… . Gere um token em /mcps.',
    )
  }

  const identity = await resolveMcpToken(token)
  if (!identity) {
    return unauthorized(
      'Token inválido, revogado ou expirado. Gere outro em /mcps.',
    )
  }

  return { userId: identity.userId }
}

async function handle(request: Request): Promise<Response> {
  const auth = await authenticate(request)
  if (auth instanceof Response) return auth

  const server = createSupremoMcpServer({ userId: auth.userId })
  // Sem sessionIdGenerator o transporte roda stateless — obrigatório em
  // serverless, onde não há memória compartilhada entre invocações.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  })

  try {
    await server.connect(transport)
    return await transport.handleRequest(request)
  } catch (error) {
    console.error('[mcp] falha ao processar requisição:', error)
    return Response.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message:
            error instanceof Error
              ? error.message
              : 'Erro interno do servidor MCP',
        },
        id: null,
      },
      { status: 500 },
    )
  }
}

export async function POST(request: Request): Promise<Response> {
  return handle(request)
}

export async function GET(request: Request): Promise<Response> {
  return handle(request)
}

export async function DELETE(request: Request): Promise<Response> {
  return handle(request)
}
