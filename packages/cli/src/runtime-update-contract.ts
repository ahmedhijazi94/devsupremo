import { z } from 'zod'

/** Engine tooling only: never the running preview, application source or schema. */
export const RUNTIME_UPDATE_PATHS = [
  'tools/supremo-cli/package.json', 'tools/supremo-cli/dist/bin.js',
  'tools/next-eslint-glob/package.json', 'tools/next-eslint-glob/index.cjs',
  'scripts/supremo-turn-hook.mjs', 'scripts/supremo-codex-hook.mjs', 'scripts/setup-local.mjs',
  'scripts/supremo-status.mjs', 'scripts/recovery-context.mjs', 'scripts/verify.mjs',
  'scripts/security-audit.js', 'scripts/acceptance-rls.mjs', 'scripts/rls-isolation-inventory.mjs',
  'scripts/rls-isolation-reporter.mjs', 'scripts/rls-isolation-gate.mjs', 'supabase/isolation.ts',
  '.github/workflows/ci.yml', '.githooks/pre-commit', '.githooks/pre-push',
  '.supremo/DEVELOPMENT.md', 'AGENTS.md', 'CLAUDE.md', '.claude/settings.json', '.codex/hooks.json',
  'vitest.config.ts', 'vitest.config.mts', 'vitest.setup.ts', 'playwright.config.ts',
  'eslint.config.mjs', 'tsconfig.json', 'e2e/smoke.spec.ts', 'package.json', 'package-lock.json',
] as const
export const runtimeUpdateAuthoritySchema = z.object({ projectId: z.string().uuid(), issuer: z.string(), revision: z.string().uuid() }).strict()
export const runtimeCandidateSchema = z.object({ projectId: z.string().uuid(), revision: z.string().uuid(), cliDigest: z.string().regex(/^[a-f0-9]{64}$/),
  templateVersion: z.string(), baseSha: z.string().regex(/^[a-f0-9]{40}$/), files: z.array(z.object({ path: z.enum(RUNTIME_UPDATE_PATHS),
    content: z.string().max(3_000_000), beforeBlob: z.string().regex(/^[a-f0-9]{40}$/).nullable() }).strict()).max(40) }).strict()
export type RuntimeCandidate = z.infer<typeof runtimeCandidateSchema>
