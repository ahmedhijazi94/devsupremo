/**
 * Verifica se um Supremo publicado está de pé e configurado.
 *
 *   npx tsx scripts/dev/check-deploy.mts https://seu-app.vercel.app
 *
 * Não precisa de credencial: só exercita o que é observável de fora.
 */

const base = process.argv[2]?.replace(/\/$/, '')

if (!base) {
  console.error('Uso: tsx scripts/dev/check-deploy.mts <url>')
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
for (const path of ['/dashboard', '/projects', '/settings', '/accounts']) {
  try {
    const response = await fetch(`${base}${path}`, { redirect: 'manual' })
    const redirected = response.status === 307 || response.status === 302
    report(redirected, `${path} exige sessão`, `HTTP ${response.status}`)
  } catch {
    report(false, `${path} exige sessão`, 'sem resposta')
  }
}

// O diagnóstico público não envia credenciais nem cria checkpoints.
// Autenticação por dispositivo e publicação são cobertas pelos testes locais.

console.log()
if (failures > 0) {
  console.log(`[31m${failures} verificação(ões) falharam.[0m\n`)
  process.exit(1)
}
console.log('[32mDeploy respondendo como esperado.[0m\n')
