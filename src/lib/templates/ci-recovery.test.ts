import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildProjectFiles } from './project-files'

describe('CI infrastructure recovery', () => {
  for (const scenario of ['transient', 'persistent', 'migration'] as const) {
    it(`${scenario}: retries only transient startup failures and never bypasses the gate`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-recovery-'))
      try {
        const ci = buildProjectFiles({ projectName: 'fixture', description: '' }).find((f) => f.path === '.github/workflows/ci.yml')!.content
        const block = ci.split('name: Preparar banco de testes com recuperação de rede')[1]!.split('\n      # O start')[0]!
        expect(block).toContain('SUPABASE_INTERNAL_IMAGE_REGISTRY: ghcr.io')
        const script = block.split('        run: |\n')[1]!.split('\n').map((line) => line.replace(/^          /, '')).join('\n')
          .replaceAll('/tmp/supremo-supabase-start.log', path.join(dir, 'start.log'))
        fs.mkdirSync(path.join(dir, 'node_modules/.bin'), { recursive: true })
        fs.writeFileSync(path.join(dir, 'node_modules/.bin/supabase'), `#!/bin/sh
count=0
if [ -f count ]; then count=$(cat count); fi
count=$((count + 1))
echo "$count" > count
if [ '${scenario}' = transient ] && [ "$count" -eq 2 ]; then exit 0; fi
if [ '${scenario}' = migration ]; then echo 'invalid migration'; else echo 'toomanyrequests: Rate exceeded'; fi
exit 1
`, { mode: 0o755 })
        fs.writeFileSync(path.join(dir, 'node_modules/.bin/sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
        // Exercise the generated retry logic without starting npm on each
        // simulated attempt or letting the fixture consult a package registry.
        fs.writeFileSync(path.join(dir, 'node_modules/.bin/npx'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 })
        const result = spawnSync('bash', ['-c', script], { cwd: dir, env: { ...process.env, PATH: `${dir}/node_modules/.bin:${process.env.PATH}` }, encoding: 'utf8', timeout: 10_000 })
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(scenario === 'transient' ? 0 : 1)
        expect(fs.readFileSync(path.join(dir, 'count'), 'utf8').trim()).toBe(scenario === 'transient' ? '2' : scenario === 'persistent' ? '3' : '1')
        // Syntax checked independently of the stub's success path.
        execFileSync('bash', ['-n'], { input: script })
      } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    }, 15_000)
  }
})
