/** Log completo de um passo específico de um job. */
import { createClient } from '@supabase/supabase-js'
import { decryptToken } from '../../src/lib/crypto'

const [repo, jobName, needle] = process.argv.slice(2)
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const { data: p } = await sb.from('projects').select('github_accounts(access_token_encrypted)').eq('github_repo_full_name', repo!).single()
const acc = p!.github_accounts as unknown as { access_token_encrypted: string }
const h = { Authorization: `Bearer ${decryptToken(acc.access_token_encrypted)}`, Accept: 'application/vnd.github+json' }

const runs = await (await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=5`, { headers: h })).json()
for (const run of runs.workflow_runs ?? []) {
  const jobs = await (await fetch(run.jobs_url, { headers: h })).json()
  const job = (jobs.jobs ?? []).find((j: { name: string }) => j.name === jobName)
  if (!job) continue
  const raw = await (await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${job.id}/logs`, { headers: h })).text()
  const lines = raw.split('\n')
  const at = lines.findIndex((l) => l.includes(needle!))
  if (at === -1) { console.log('marcador não encontrado neste job'); break }
  console.log(lines.slice(at, at + 40).map(l => l.replace(/^\S+Z /, '')).join('\n'))
  break
}
