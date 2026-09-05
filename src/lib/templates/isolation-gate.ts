import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Standalone test tooling: no imports into app runtime or the editing harness. */
export function isolationGateFiles(): Array<{ path: string; content: string }> {
  const scripts = ['rls-isolation-inventory.mjs', 'rls-isolation-reporter.mjs', 'rls-isolation-gate.mjs']
  return [
    ...scripts.map((name) => ({ path: `scripts/${name}`, content: readFileSync(join(process.cwd(), 'scripts', name), 'utf8') })),
    { path: 'supabase/isolation.ts', content: readFileSync(join(process.cwd(), 'src/lib/templates/assets/rls/isolation.ts.txt'), 'utf8') },
  ]
}
