/**
 * Monta o que precisa ser colado na Vercel, sem você ter que decidir nada.
 *
 *   npx tsx scripts/dev/preparar-deploy.mts https://seu-dominio.vercel.app
 *
 * Gera DEPLOY.txt na raiz do projeto com os valores já prontos, na ordem.
 * O arquivo tem segredos: está no .gitignore e você deve apagá-lo depois.
 */
import fs from 'node:fs'
import path from 'node:path'

const domain = process.argv[2]?.replace(/\/$/, '')

if (!domain) {
  console.error('Uso: npx tsx scripts/dev/preparar-deploy.mts <url-de-producao>')
  console.error('Exemplo: npx tsx scripts/dev/preparar-deploy.mts https://supremo.vercel.app')
  process.exit(1)
}

if (!domain.startsWith('https://')) {
  console.error('A URL precisa começar com https://')
  process.exit(1)
}

const envPath = path.join(process.cwd(), '.env.local')
if (!fs.existsSync(envPath)) {
  console.error('.env.local não encontrado. Rode isto na raiz do projeto.')
  process.exit(1)
}

const local = new Map<string, string>()
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const match = /^([A-Z_0-9]+)\s*=\s*(.*)$/.exec(line.trim())
  if (match?.[1]) local.set(match[1], (match[2] ?? '').replace(/^["']|["']$/g, ''))
}

/** O que a Vercel precisa ter. */
const REQUIRED = [
  'ENCRYPTION_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'SUPABASE_OAUTH_CLIENT_ID',
  'SUPABASE_OAUTH_CLIENT_SECRET',
] as const

const missing = REQUIRED.filter((name) => !local.get(name))
const lines: string[] = []

lines.push('PASSO 1 — Variáveis na Vercel')
lines.push('Projeto supremo > Settings > Environment Variables.')
lines.push('Cole uma por uma. Marque Production, Preview e Development nas três.')
lines.push('')

for (const name of REQUIRED) {
  lines.push(`${name}=${local.get(name) ?? '<<FALTANDO NO SEU .env.local>>'}`)
}
lines.push(`NEXT_PUBLIC_APP_URL=${domain}`)

lines.push('')
lines.push('Se existir SUPREMO_API_KEY na Vercel, APAGUE. Nenhum código lê mais.')
lines.push('')
lines.push('─'.repeat(60))
lines.push('')
lines.push('PASSO 2 — Conectar o repositório')
lines.push('Vercel > projeto supremo > Settings > Git > Connect Git Repository')
lines.push('Escolha: ahmedhijazi94/devsupremo')
lines.push('')
lines.push('É isto que faz push virar deploy. Hoje não está ligado.')
lines.push('')
lines.push('─'.repeat(60))
lines.push('')
lines.push('PASSO 3 — Callback do GitHub')
lines.push('https://github.com/settings/developers > seu OAuth App')
lines.push('Campo "Authorization callback URL", cole:')
lines.push('')
lines.push(`${domain}/auth/github-account/callback`)
lines.push('')
lines.push('─'.repeat(60))
lines.push('')
lines.push('PASSO 4 — Redirect do Supabase')
lines.push('Supabase > Authentication > URL Configuration')
lines.push('')
lines.push(`Site URL:      ${domain}`)
lines.push(`Redirect URLs: ${domain}/**`)
lines.push('')
lines.push('─'.repeat(60))
lines.push('')
lines.push('PASSO 5 — Mergear o PR')
lines.push('https://github.com/ahmedhijazi94/devsupremo/pull/1')
lines.push('')
lines.push('PASSO 6 — Conferir')
lines.push(`npx tsx scripts/dev/check-deploy.mts ${domain}`)
lines.push('')
lines.push('Depois apague este arquivo: rm DEPLOY.txt')

const out = path.join(process.cwd(), 'DEPLOY.txt')
fs.writeFileSync(out, lines.join('\n'), { mode: 0o600 })

console.log(`\nPronto: ${out}`)
console.log('Abra o arquivo e siga de cima para baixo. Cada valor já está montado.\n')

if (missing.length > 0) {
  console.log('Atenção — faltam no seu .env.local:')
  for (const name of missing) console.log(`  ${name}`)
  console.log('')
}

console.log('O arquivo contém segredos. Apague quando terminar: rm DEPLOY.txt\n')
