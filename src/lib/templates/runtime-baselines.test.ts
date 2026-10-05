import { expect, it } from 'vitest'
import { hasOfficialRuntimeBase } from './runtime-baselines'

it('recognizes published tooling and gates without trusting a project-provided version or hash', () => {
  expect(hasOfficialRuntimeBase('scripts/setup-local.mjs', '44f2b3149873ce5f7f0113da9906180381057e76', 'solo')).toBe(true)
  expect(hasOfficialRuntimeBase('scripts/setup-local.mjs', 'c'.repeat(40), 'solo')).toBe(false)
  expect(hasOfficialRuntimeBase('scripts/verify.mjs', 'ab5e3af6f6ea8445fa697dd992137dbe8d73bb42', 'solo')).toBe(true)
  expect(hasOfficialRuntimeBase('scripts/verify.mjs', 'c'.repeat(40), 'solo')).toBe(false)
  expect(hasOfficialRuntimeBase('scripts/new-tool.mjs', null, 'solo')).toBe(true)
})
it('permits personalized content only through the explicit block/field-aware mergers', () => {
  for (const file of ['AGENTS.md', 'CLAUDE.md', 'package.json', 'package-lock.json', '.claude/settings.json', '.codex/hooks.json']) {
    expect(hasOfficialRuntimeBase(file, 'c'.repeat(40), 'solo')).toBe(true)
  }
  expect(hasOfficialRuntimeBase('.supremo/DEVELOPMENT.md', 'c'.repeat(40), 'solo')).toBe(false)
  expect(hasOfficialRuntimeBase('scripts/supremo-turn-hook.mjs', 'c'.repeat(40), 'solo')).toBe(false)
})
