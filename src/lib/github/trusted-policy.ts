import { TRUSTED_VALIDATION_POLICIES } from '../../../packages/cli/src/generated/validation-policy'
import { blobHash, inspectValidationIntegrity, type PolicyTreeEntry } from '../../../packages/cli/src/validation-integrity'
import type { CheckRun } from './merge-policy'
import type { FileOp } from '../checkpoint/changeset'

export interface ValidationAuthority { approved: boolean; headSha: string; reasons: string[] }

/** Reject altered execution rails BEFORE publishing them to a CI runner. */
export function verifyPolicyChanges(kind: string | null, files: readonly FileOp[]): string[] {
  const manifest = TRUSTED_VALIDATION_POLICIES.find(policy => policy.kind === (kind ?? 'solo'))
  if (!manifest) return ['Tipo de projeto sem política publicada.']
  return files.flatMap(file => {
    const expected = manifest.files[file.path]
    if (!expected && !file.path.startsWith('.github/workflows/')) return []
    if (expected && file.op !== 'delete' && file.contentBase64 !== undefined && blobHash(Buffer.from(file.contentBase64, 'base64').toString('utf8')) === expected) return []
    return [`Publicação de validador não autorizado: ${file.path}`]
  })
}

export function verifyCandidatePolicy(input: {
  headSha: string; kind: string | null; tree: readonly PolicyTreeEntry[];
  truncated: boolean; packageContent: string; lockContent: string;
}): ValidationAuthority {
  const manifest = TRUSTED_VALIDATION_POLICIES.find(policy => policy.kind === (input.kind ?? 'solo'))
  const reasons = !/^[a-f0-9]{40}$/.test(input.headSha) ? ['Revisão de validação inválida.']
    : input.truncated ? ['Árvore incompleta: a política não pode ser comprovada.']
    : !manifest ? ['Tipo de projeto sem política publicada.']
    : inspectValidationIntegrity(manifest, input.tree, input.packageContent, input.lockContent)
  return { approved: reasons.length === 0, headSha: input.headSha, reasons: reasons.slice(0, 12) }
}

export interface WorkflowEvidence {
  id: number; head_sha: string; path: string; event: string;
  run_number: number; run_attempt?: number; status: string | null; conclusion: string | null;
}

/** Other apps' check names are not proof that our pinned workflow ran. */
export function selectTrustedWorkflow(runs: readonly WorkflowEvidence[], sha: string): WorkflowEvidence | undefined {
  return runs.filter(run => run.head_sha === sha && run.path === '.github/workflows/ci.yml' &&
    ['pull_request', 'push'].includes(run.event))
    .sort((a, b) => b.run_number - a.run_number || (b.run_attempt ?? 1) - (a.run_attempt ?? 1))[0]
}

export function workflowChecks(run: WorkflowEvidence | undefined, jobs: readonly CheckRun[]): CheckRun[] {
  if (!run) return []
  // Ambiguous duplicated job names cannot satisfy an authoritative gate.
  const names = new Map<string, number>()
  for (const job of jobs) names.set(job.name, (names.get(job.name) ?? 0) + 1)
  return jobs.map(job => names.get(job.name) === 1 ? job : { ...job, conclusion: 'failure' })
}
