/**
 * Busca o log dos jobs que falharam no CI de um projeto do Supremo.
 * É a versão de linha de comando do que a ferramenta get_failed_logs faz.
 *
 *   npx tsx scripts/dev/failure-log.mts <owner/repo>
 */
import { createClient } from '@supabase/supabase-js'
import { decryptToken } from '../../src/lib/crypto'

interface WorkflowRun {
  event: string
  head_branch: string
  status: string
  conclusion: string | null
  jobs_url: string
}

interface WorkflowJob {
  id: number
  name: string
  status: string
  conclusion: string | null
  steps?: Array<{ name: string; conclusion: string | null }>
}

const repo = process.argv[2]!
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const { data: p } = await sb.from('projects')
  .select('github_accounts(access_token_encrypted)')
  .eq('github_repo_full_name', repo).single()
const acc = p!.github_accounts as unknown as { access_token_encrypted: string }
const h = { Authorization: `Bearer ${decryptToken(acc.access_token_encrypted)}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }

const runs = await (await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=20`, { headers: h })).json()
const byEvent: Record<string, number> = {}
for (const r of (runs.workflow_runs ?? []) as WorkflowRun[]) byEvent[r.event] = (byEvent[r.event] ?? 0) + 1
console.log('runs por evento:', JSON.stringify(byEvent))

const pushRun = ((runs.workflow_runs ?? []) as WorkflowRun[]).find((r) => r.event === 'push')
console.log('run de push existe?', pushRun ? `sim (${pushRun.conclusion ?? pushRun.status})` : 'NÃO')

const run = pushRun ?? runs.workflow_runs?.[0]
if (!run) process.exit(0)
console.log(`\ninspecionando: ${run.event} · ${run.head_branch}\n`)

const jobs = await (await fetch(run.jobs_url, { headers: h })).json()
const failed = ((jobs.jobs ?? []) as WorkflowJob[]).filter((j) => j.conclusion === 'failure')
for (const j of failed.slice(0, 2)) {
  console.log(`══ ${j.name} ══`)
  for (const s of j.steps ?? []) {
    if (s.conclusion === 'failure') console.log(`  passo que falhou: ${s.name}`)
  }
  const lg = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${j.id}/logs`, { headers: h })
  const text = await lg.text()
  console.log(text.split('\n').slice(-28).join('\n'))
  console.log()
}
