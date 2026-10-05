import { isReleasedValidationFile } from '../github/trusted-policy'

// Generated from buildProjectFiles for both stacks/all kinds at published engine
// 411d505da9f90c3ef745177d85c312603b13412d (CLI 1.13.0). These are official
// template bytes, never hashes learned from a project's mutable branch.
const previousTooling: Readonly<Record<string, readonly string[]>> = {
  '.supremo/DEVELOPMENT.md': ['ae37c479964b57c4cdfc1298d0b8a29ee04312b1', '215aa6eaa49ab69989125f339f988f34b1c3618b'],
  'scripts/supremo-codex-hook.mjs': ['72f97ae875663d8ea2a348db7ec2c234031cd15d'],
  'scripts/supremo-turn-hook.mjs': ['e15eab7083405e4220f726050b6345ea0f7cd4cc'],
  'scripts/recovery-context.mjs': ['3bf9b920df719fc5d236a4664b22267348f5bf61'],
  'scripts/setup-local.mjs': ['44f2b3149873ce5f7f0113da9906180381057e76', '77e7362d1241bf4c23541eb5a415db1cf0b537ba'],
  'scripts/supremo-status.mjs': ['a3a01ac84a6dda6d3bdf264065ee3cf4ed3ce226', '9a8de0940b2f408f64c4ecf15852abcabea74524'],
  '.githooks/pre-commit': ['90b26ba1b4ab2324532cc49f5fb692bdcf861fee'],
  '.githooks/pre-push': ['4df942097c18931520ef24372f52263fc6500cc4'],
}

// These have field/block-aware mergers. All other files are replaced in full
// and must match a previously published template before automatic replacement.
const mergedPaths = new Set(['AGENTS.md', 'CLAUDE.md', 'package.json', 'package-lock.json', '.claude/settings.json', '.codex/hooks.json'])

export function hasOfficialRuntimeBase(file: string, beforeBlob: string | null, kind: string): boolean {
  return beforeBlob === null || mergedPaths.has(file) || previousTooling[file]?.includes(beforeBlob) === true
    || isReleasedValidationFile(kind, file, beforeBlob)
}
