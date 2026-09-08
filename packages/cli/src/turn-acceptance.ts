import { z } from 'zod'
import { acceptanceCriterionSchema } from './turn-model'
import { ACCEPTANCE_TEST_PATH_SOURCE } from '../../../src/lib/checkpoint/acceptance-path'

const testPath = z.string().min(1).max(300).regex(new RegExp(ACCEPTANCE_TEST_PATH_SOURCE),
  'Test path must name a project test using a canonical relative path')
/** Explicit behavior→named proof contract; no guessed acceptance or arbitrary shell commands. */
export const acceptanceContractSchema = z.object({
  version: z.literal(1), criteria: z.array(acceptanceCriterionSchema).min(1).max(100),
  checks: z.array(z.object({ name: z.string().min(1).max(200), type: z.enum(['unit', 'e2e', 'rls']),
    files: z.array(testPath).min(1).max(30) })).min(1).max(50),
}).superRefine((contract, context) => {
  const names = new Set(contract.checks.map((check) => check.name))
  if (names.size !== contract.checks.length || new Set(contract.criteria.map((item) => item.id)).size !== contract.criteria.length) {
    context.addIssue({ code: 'custom', message: 'Acceptance IDs and check names must be unique' })
  }
  for (const criterion of contract.criteria) {
    if (criterion.requiredChecks.some((name) => !names.has(name))) context.addIssue({ code: 'custom', message: 'Criterion refers to missing proof' })
  }
  if (contract.checks.some((check) => check.type !== 'rls' && check.files.some((file) => file.startsWith('supabase/')))) {
    context.addIssue({ code: 'custom', message: 'Supabase isolation tests require the RLS environment gate' })
  }
})
export type AcceptanceContract = z.infer<typeof acceptanceContractSchema>
