/**
 * Monta o que preencher no console de Integrations da Vercel e manda as
 * variáveis resultantes para a produção.
 *
 * Passo 1 — veja o que preencher:
 *   npx tsx scripts/dev/preparar-vercel-oauth.mts
 *
 * Passo 2 — depois de criar a Integration, salve as três variáveis:
 *   npx tsx scripts/dev/preparar-vercel-oauth.mts --salvar
 *
 * O segundo passo lê VERCEL_CLIENT_ID, VERCEL_CLIENT_SECRET e
 * VERCEL_INTEGRATION_SLUG do .env.local e as envia para a Vercel. Nenhum
 * valor é impresso.
 */
import fs from 'node:fs'
import path from 'node:path'

const salvar = process.argv.includes('--salvar')

const envPath = path.join(process.cwd(), '.env.local')
if (!fs.existsSync(envPath)) {
  console.error('.env.local não encontrado. Rode na raiz do projeto.')
  process.exit(1)
}

const local = new Map<string, string>()
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const match = /^([A-Z_0-9]+)\s*=\s*(.*)$/.exec(line.trim())
  if (match?.[1]) local.set(match[1], (match[2] ?? '').replace(/^["']|["']$/g, ''))
}

// O .env.local aponta para localhost em desenvolvimento, mas a Redirect URL
// da Integration precisa ser a de produção. Aceita override por argumento.
const explicit = process.argv.find((arg) => arg.startsWith('https://'))
const appUrl = (explicit ?? local.get('NEXT_PUBLIC_APP_URL') ?? '').replace(
  /\/$/,
  ''
)

if (!appUrl) {
  console.error(
    'Informe a URL de produção:\n' +
      '  npx tsx scripts/dev/preparar-vercel-oauth.mts https://seu-dominio\n'
  )
  process.exit(1)
}

if (appUrl.startsWith('http://localhost')) {
  console.log(
    '\nAtenção: usando localhost. Para a Integration de produção, passe a URL:\n' +
      '  npx tsx scripts/dev/preparar-vercel-oauth.mts https://seu-dominio\n'
  )
}

const REQUIRED = [
  'VERCEL_CLIENT_ID',
  'VERCEL_CLIENT_SECRET',
  'VERCEL_INTEGRATION_SLUG',
] as const

// ─────────────────────────────────────────────────────────────
// Passo 1 — instruções
// ─────────────────────────────────────────────────────────────

if (!salvar) {
  console.log(`
Abra https://vercel.com/dashboard/integrations/console e crie uma Integration.

Preencha assim — o resto pode ficar no padrão:

  Name                  Supremo
  Slug                  supremo
  Developer             (seu nome)
  Redirect URL          ${appUrl}/auth/vercel-account/callback

  Scopes  ────────────────────────────────────────────────
    Projects            Read/Write   (criar o projeto do usuário)
    Deployments         Read         (mostrar o estado do preview)
    Environment          Read/Write  (injetar as chaves do Supabase)

Ao salvar, a Vercel mostra Client ID e Client Secret.

Adicione as três linhas no .env.local:

  VERCEL_CLIENT_ID=o_client_id
  VERCEL_CLIENT_SECRET=o_client_secret
  VERCEL_INTEGRATION_SLUG=supremo

Depois rode:

  npx tsx scripts/dev/preparar-vercel-oauth.mts --salvar

O slug precisa ser exatamente o mesmo do campo Slug — é ele que monta a URL
de instalação.
`)

  const missing = REQUIRED.filter((name) => !local.get(name))
  if (missing.length === 0) {
    console.log('As três já estão no .env.local. Rode com --salvar.\n')
  }
  process.exit(0)
}

// ─────────────────────────────────────────────────────────────
// Passo 2 — enviar para a produção
// ─────────────────────────────────────────────────────────────

const missing = REQUIRED.filter((name) => !local.get(name))
if (missing.length > 0) {
  console.error(`\nFaltam no .env.local:\n${missing.map((n) => `  ${n}`).join('\n')}\n`)
  process.exit(1)
}

const vercelToken = local.get('VERCEL_TOKEN')
if (!vercelToken) {
  console.error(
    '\nFalta VERCEL_TOKEN no .env.local para enviar as variáveis à produção.' +
      '\nPegue um em https://vercel.com/account/tokens\n'
  )
  process.exit(1)
}

const link = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), '.vercel', 'project.json'), 'utf8')
) as { projectId: string; orgId: string }

let failures = 0

for (const key of REQUIRED) {
  const response = await fetch(
    `https://api.vercel.com/v10/projects/${link.projectId}/env?upsert=true&teamId=${link.orgId}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${vercelToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        key,
        value: local.get(key),
        type: 'encrypted',
        target: ['production', 'preview', 'development'],
      }),
    }
  )

  if (response.ok) {
    console.log(`  [32m✓[0m ${key}`)
  } else {
    console.log(`  [31m✗[0m ${key} — HTTP ${response.status}`)
    failures++
  }
}

console.log(
  failures === 0
    ? '\nPronto. O próximo deploy já mostra o botão de um clique em Contas.\n'
    : '\nAlguma variável não subiu. Confira o VERCEL_TOKEN.\n'
)

process.exit(failures > 0 ? 1 : 0)
