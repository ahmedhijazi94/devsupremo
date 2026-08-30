/**
 * Verifica se um Supremo publicado está de pé e configurado.
 *
 *   npx tsx scripts/dev/check-deploy.mts https://seu-app.vercel.app
 *
 * Não precisa de credencial: só exercita o que é observável de fora.
 * Para checar o MCP autenticado, passe um token:
 *
 *   npx tsx scripts/dev/check-deploy.mts https://seu-app.vercel.app sup_...
 */

const base = process.argv[2]?.replace(/\/$/, '')
const token = process.argv[3]

if (!base) {
  console.error('Uso: tsx scripts/dev/check-deploy.mts <url> [token]')
  process.exit(1)
}

let failures = 0

function report(ok: boolean, label: string, detail = '') {
  const mark = ok ? '[32m✓[0m' : '[31m✗[0m'
  console.log(`  ${mark} ${label.padEnd(42)} ${detail}`)
  if (!ok) failures++
}

// ── A aplicação responde ─────────────────────────────────────
try {
  const home = await fetch(`${base}/`, { redirect: 'manual' })
  report(
    home.status < 500,
    'a home responde',
    `HTTP ${home.status}`
  )

  const headers = home.headers
  report(
    headers.get('strict-transport-security') !== null,
    'HSTS presente'
  )
  report(
    headers.get('x-content-type-options') === 'nosniff',
    'X-Content-Type-Options'
  )
  report(
    headers.get('x-frame-options') !== null,
    'X-Frame-Options'
  )
} catch (error) {
  report(false, 'a home responde', String(error))
}

// ── Rotas protegidas redirecionam ────────────────────────────
for (const path of ['/dashboard', '/projects', '/mcps', '/settings', '/accounts']) {
  try {
    const response = await fetch(`${base}${path}`, { redirect: 'manual' })
    const redirected = response.status === 307 || response.status === 302
    report(redirected, `${path} exige sessão`, `HTTP ${response.status}`)
  } catch {
    report(false, `${path} exige sessão`, 'sem resposta')
  }
}

// ── O MCP está no ar e recusa quem não tem token ─────────────
try {
  const anonymous = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })
  report(
    anonymous.status === 401,
    'MCP recusa requisição sem token',
    `HTTP ${anonymous.status}`
  )
  report(
    (anonymous.headers.get('www-authenticate') ?? '').includes('Bearer'),
    'MCP anuncia o esquema Bearer'
  )
} catch (error) {
  report(false, 'o endpoint MCP responde', String(error))
}

// ── Com token: handshake completo ────────────────────────────
if (token) {
  try {
    const response = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'check-deploy', version: '1' },
        },
      }),
    })

    const body = (await response.json()) as {
      result?: { serverInfo?: { name: string }; instructions?: string }
      error?: { message: string }
    }

    report(
      body.result?.serverInfo?.name === 'supremo',
      'handshake do MCP com token',
      body.error?.message ?? ''
    )
    report(
      (body.result?.instructions ?? '').includes('get_project_context'),
      'as regras chegam no handshake'
    )
  } catch (error) {
    report(false, 'handshake do MCP com token', String(error))
  }
} else {
  console.log('  [2m·[0m passe um token para checar o MCP autenticado')
}

console.log()
if (failures > 0) {
  console.log(`[31m${failures} verificação(ões) falharam.[0m\n`)
  process.exit(1)
}
console.log('[32mDeploy respondendo como esperado.[0m\n')
