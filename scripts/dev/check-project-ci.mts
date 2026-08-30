/**
 * Estado do CI de um projeto provisionado pelo Supremo.
 * Usa a conta GitHub que está vinculada ao projeto — não a primeira do banco.
 *
 *   npx tsx scripts/dev/check-project-ci.mts <owner/repo>
 */
import { createClient } from '@supabase/supabase-js'
import { decryptToken } from '../../src/lib/crypto'

const repo = process.argv[2]
if (!repo) {
  console.error('Uso: tsx scripts/dev/check-project-ci.mts <owner/repo>')
  process.exit(1)
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const { data: project } = await sb
  .from('projects')
  .select('github_accounts(login, access_token_encrypted)')
  .eq('github_repo_full_name', repo)
  .single()

const acc = project!.github_accounts as unknown as {
  login: string
  access_token_encrypted: string
}

const h = {
  Authorization: `Bearer ${decryptToken(acc.access_token_encrypted)}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
}

console.log(`conta: ${acc.login}\n`)

const runs = await (
  await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=5`, { headers: h })
).json()

console.log(`runs de CI: ${runs.total_count ?? 0}`)

for (const r of runs.workflow_runs ?? []) {
  console.log(`\n  ${r.name} · ${r.event} · ${r.status} · ${r.conclusion ?? 'em andamento'}`)
  const jobs = await (await fetch(r.jobs_url, { headers: h })).json()
  for (const j of jobs.jobs ?? []) {
    const mark =
      j.conclusion === 'success' ? '✓' : j.conclusion === 'failure' ? '✗' : '·'
    console.log(`      ${mark} ${String(j.name).padEnd(30)} ${j.conclusion ?? j.status}`)
  }
}

const prot = await fetch(
  `https://api.github.com/repos/${repo}/branches/main/protection`,
  { headers: h }
)
console.log(
  `\nproteção de branch: ${prot.status === 200 ? 'ativa' : `não aplicada (HTTP ${prot.status})`}`
)
