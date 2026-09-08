import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'

const installer = 'scripts/dev/install-test-pg-cron.sh'
describe('disposable CI pg_cron installation', () => {
  it('refuses before any package installation when disposable-container authorization is absent', () => {
    const result = spawnSync('bash', [installer], { encoding: 'utf8', env: { ...process.env, SUPREMO_DISPOSABLE_PG_CRON: '0' } })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Refusing installation outside an explicitly authorized disposable PostgreSQL container')
    expect(result.stdout).toBe('')
    expect(() => execFileSync('bash', ['-n', installer])).not.toThrow()
  })
  it('verifies the exact official source before compilation and configures only the disposable service', () => {
    const script = readFileSync(installer, 'utf8')
    expect(script).toContain("cron_tag='v1.6.7'")
    expect(script).toContain("cron_commit='465b38c737f584d520229f5a1d69d1d44649e4e5'")
    expect(script).toContain('https://github.com/citusdata/pg_cron.git')
    expect(script.indexOf('rev-parse FETCH_HEAD')).toBeLessThan(script.indexOf('make -C'))
    expect(script).toContain('cron.use_background_workers = on')
    expect(script).toContain('cron.log_run = on')
  })
  it('requires the real scheduler alongside the existing RLS and migration checks', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')
    const job = workflow.split('  template-rls:')[1]!.split('\n  template:')[0]!
    expect(job).toContain('${{ job.services.postgres.id }}')
    expect(job).toContain('docker restart "$POSTGRES_CONTAINER"')
    expect(job).toContain('scripts/dev/install-test-pg-cron.sh')
    expect(job).toContain('scripts/test-secret-requests.mts')
    expect(job).toContain('scripts/test-database-jobs.mts')
    expect(job).toContain("SUPREMO_TEST_REAL_CRON: '1'")
    expect(job).toContain('SUPREMO_TEST_CRON_DATABASE: supremo_jobs_ci')
    expect(job).not.toContain('continue-on-error')
  })
})
