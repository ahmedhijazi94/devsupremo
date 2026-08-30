/** Estado do projeto na Vercel: deploys recentes e configuração de build. */
import fs from 'node:fs'
import path from 'node:path'

const local = new Map<string, string>()
for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const m = /^([A-Z_0-9]+)\s*=\s*(.*)$/.exec(line.trim())
  if (m?.[1]) local.set(m[1], (m[2] ?? '').replace(/^["']|["']$/g, ''))
}
const token = local.get('VERCEL_TOKEN')
if (!token) { console.error('Falta VERCEL_TOKEN no .env.local'); process.exit(1) }

const link = JSON.parse(
  fs.readFileSync(path.join('.vercel', 'project.json'), 'utf8')
) as { projectId: string; orgId: string }

const h = { Authorization: `Bearer ${token}` }
const q = `teamId=${link.orgId}`

const project = await (await fetch(
  `https://api.vercel.com/v9/projects/${link.projectId}?${q}`, { headers: h }
)).json()

console.log('── configuração ──')
console.log('  branch de produção:', project.link?.productionBranch ?? '(padrão)')
console.log('  repositório:       ', project.link ? `${project.link.org}/${project.link.repo}` : 'NÃO CONECTADO')
console.log('  framework:         ', project.framework)
console.log('  root directory:    ', project.rootDirectory ?? '(raiz)')
console.log('  build command:     ', project.buildCommand ?? '(padrão)')
console.log('  ignora builds:     ', project.ignoreCommand ?? 'não')
console.log('  deploys pausados:  ', project.paused ? 'SIM' : 'não')

const deployments = await (await fetch(
  `https://api.vercel.com/v6/deployments?projectId=${link.projectId}&limit=8&${q}`, { headers: h }
)).json()

console.log(`\n── deploys (${deployments.deployments?.length ?? 0}) ──`)
for (const d of deployments.deployments ?? []) {
  const when = new Date(d.created).toLocaleString('pt-BR')
  const branch = d.meta?.githubCommitRef ?? '—'
  console.log(`  ${String(d.state).padEnd(10)} ${String(d.target ?? 'preview').padEnd(11)} ${branch.padEnd(28)} ${when}`)
  if (d.url) console.log(`     https://${d.url}`)
}
if (!deployments.deployments?.length) console.log('  nenhum deploy jamais foi criado neste projeto')
