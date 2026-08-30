/**
 * Estado do CI e dos deploys de qualquer repositório do usuário.
 * Diferente de check-project-ci, não exige que o repo esteja no Supremo.
 *
 *   npx tsx scripts/dev/check-repo-ci.mts <owner/repo> [branch]
 */
import { createClient } from '@supabase/supabase-js'
import { decryptToken } from '../../src/lib/crypto'

const [repo, branch] = process.argv.slice(2)
if (!repo) {
  console.error('Uso: tsx scripts/dev/check-repo-ci.mts <owner/repo> [branch]')
  process.exit(1)
}

const owner = repo.split('/')[0]
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const { data: accounts } = await sb.from('github_accounts').select('login, access_token_encrypted')
const account = (accounts ?? []).find((a) => a.login === owner) ?? accounts?.[0]
if (!account) { console.error('Nenhuma conta GitHub conectada.'); process.exit(1) }

const h = {
  Authorization: `Bearer ${decryptToken(account.access_token_encrypted as string)}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
}

const query = branch ? `?branch=${encodeURIComponent(branch)}&per_page=3` : '?per_page=3'
const runs = await (await fetch(`https://api.github.com/repos/${repo}/actions/runs${query}`, { headers: h })).json()

console.log(`── CI (${runs.total_count ?? 0} runs) ──`)
for (const run of (runs.workflow_runs ?? []).slice(0, 2)) {
  console.log(`\n  ${run.name} · ${run.head_branch} · ${run.status} · ${run.conclusion ?? 'em andamento'}`)
  const jobs = await (await fetch(run.jobs_url, { headers: h })).json()
  for (const j of jobs.jobs ?? []) {
    const m = j.conclusion === 'success' ? '✓' : j.conclusion === 'failure' ? '✗' : j.conclusion === 'skipped' ? '−' : '·'
    console.log(`      ${m} ${String(j.name).padEnd(32)} ${j.conclusion ?? j.status}`)
  }
}

// Deploys registrados no GitHub — é assim que a Vercel anuncia o preview
const deployQuery = branch ? `?ref=${encodeURIComponent(branch)}&per_page=5` : '?per_page=5'
const deploys = await (await fetch(`https://api.github.com/repos/${repo}/deployments${deployQuery}`, { headers: h })).json()

console.log(`\n── deploys (${Array.isArray(deploys) ? deploys.length : 0}) ──`)
for (const d of Array.isArray(deploys) ? deploys : []) {
  const statuses = await (await fetch(d.statuses_url, { headers: h })).json()
  const latest = (statuses ?? [])[0]
  console.log(`  ${String(d.environment).padEnd(22)} ${latest?.state ?? '—'}`)
  if (latest?.environment_url) console.log(`     ${latest.environment_url}`)
}
if (!Array.isArray(deploys) || deploys.length === 0) {
  console.log('  nenhum — a Vercel ainda não registrou deploy para esta ref')
}
