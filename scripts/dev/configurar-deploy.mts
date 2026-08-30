/**
 * Configura o deploy sozinho: manda as variáveis para a Vercel e ajusta as
 * URLs de login no Supabase.
 *
 *   npx tsx scripts/dev/configurar-deploy.mts https://supremo-three.vercel.app
 *
 * Precisa de VERCEL_TOKEN no .env.local. O token nunca é impresso.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { decryptToken } from '../../src/lib/crypto'

const domain = process.argv[2]?.replace(/\/$/, '')
if (!domain?.startsWith('https://')) {
  console.error('Uso: npx tsx scripts/dev/configurar-deploy.mts https://seu-dominio')
  process.exit(1)
}

// ── Lê o .env.local ──────────────────────────────────────────
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

const vercelToken = local.get('VERCEL_TOKEN')
if (!vercelToken) {
  console.error(`
Falta o VERCEL_TOKEN no .env.local.

Como pegar:
  1. Abra https://vercel.com/account/tokens
  2. Create Token, nome "supremo-setup", escopo do seu time
  3. Copie o valor
  4. Adicione uma linha no .env.local:

     VERCEL_TOKEN=cole_aqui

Depois rode este comando de novo.
`)
  process.exit(1)
}

// ── Projeto da Vercel ────────────────────────────────────────
const linkPath = path.join(process.cwd(), '.vercel', 'project.json')
if (!fs.existsSync(linkPath)) {
  console.error('.vercel/project.json não encontrado.')
  process.exit(1)
}
const link = JSON.parse(fs.readFileSync(linkPath, 'utf8')) as {
  projectId: string
  orgId: string
}

const VARS = [
  'ENCRYPTION_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'SUPABASE_OAUTH_CLIENT_ID',
  'SUPABASE_OAUTH_CLIENT_SECRET',
] as const

let failures = 0
const ok = (l: string) => console.log(`  [32m✓[0m ${l}`)
const bad = (l: string, d = '') => { console.log(`  [31m✗[0m ${l} ${d}`); failures++ }

// ── 1. Variáveis na Vercel ───────────────────────────────────
console.log('\n── Vercel: variáveis de ambiente ──')

const vercelBase = `https://api.vercel.com/v10/projects/${link.projectId}/env?upsert=true&teamId=${link.orgId}`

for (const key of [...VARS, 'NEXT_PUBLIC_APP_URL'] as const) {
  const value = key === 'NEXT_PUBLIC_APP_URL' ? domain : local.get(key)

  if (!value) { bad(key, '(não está no .env.local)'); continue }

  const response = await fetch(vercelBase, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${vercelToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      key,
      value,
      type: key.startsWith('NEXT_PUBLIC_') ? 'plain' : 'encrypted',
      target: ['production', 'preview', 'development'],
    }),
  })

  if (response.ok) ok(key)
  else bad(key, `HTTP ${response.status} ${(await response.text()).slice(0, 120)}`)
}

// ── 2. Remover a chave global antiga ─────────────────────────
console.log('\n── Vercel: limpeza ──')
try {
  const listed = await fetch(
    `https://api.vercel.com/v9/projects/${link.projectId}/env?teamId=${link.orgId}`,
    { headers: { Authorization: `Bearer ${vercelToken}` } }
  )
  const body = (await listed.json()) as { envs?: Array<{ id: string; key: string }> }
  const stale = (body.envs ?? []).filter((e) => e.key === 'SUPREMO_API_KEY')

  if (stale.length === 0) ok('SUPREMO_API_KEY não está lá')
  for (const entry of stale) {
    const removed = await fetch(
      `https://api.vercel.com/v9/projects/${link.projectId}/env/${entry.id}?teamId=${link.orgId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${vercelToken}` } }
    )
    removed.ok
      ? ok('SUPREMO_API_KEY removida (era a chave global insegura)')
      : bad('remover SUPREMO_API_KEY', `HTTP ${removed.status}`)
  }
} catch (error) {
  bad('limpeza', String(error))
}

// ── 3. URLs de login no Supabase ─────────────────────────────
console.log('\n── Supabase: URLs de login ──')

const projectRef = local
  .get('NEXT_PUBLIC_SUPABASE_URL')
  ?.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1]

if (!projectRef) {
  bad('descobrir o projeto Supabase pela URL')
} else {
  const sb = createClient(
    local.get('NEXT_PUBLIC_SUPABASE_URL')!,
    local.get('SUPABASE_SERVICE_ROLE_KEY')!
  )
  const { data: accounts } = await sb
    .from('supabase_accounts')
    .select('access_token_encrypted')
    .limit(1)

  const encrypted = accounts?.[0]?.access_token_encrypted as string | undefined

  if (!encrypted) {
    bad('conta Supabase conectada', '(configure Site URL e Redirect à mão)')
  } else {
    const response = await fetch(
      `https://api.supabase.com/v1/projects/${projectRef}/config/auth`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${decryptToken(encrypted)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          site_url: domain,
          uri_allow_list: [`${domain}/**`, 'http://localhost:3000/**'].join(','),
        }),
      }
    )

    response.ok
      ? ok('Site URL e Redirect URLs atualizadas')
      : bad('atualizar o Supabase', `HTTP ${response.status} — ajuste à mão`)
  }
}

// ── Resumo ───────────────────────────────────────────────────
console.log(`
${'─'.repeat(58)}

O que ainda depende de você — duas coisas:

  1. Conectar o repositório na Vercel
     https://vercel.com/ahmeds-projects-c39c0ea3/supremo/settings/git
     Botão "Connect Git Repository" > escolha ahmedhijazi94/devsupremo

  2. Colar a URL de callback no GitHub
     https://github.com/settings/developers > seu OAuth App
     Campo "Authorization callback URL":
     ${domain}/auth/github-account/callback

Depois disso, mergear o PR publica o site.
`)

process.exit(failures > 0 ? 1 : 0)
