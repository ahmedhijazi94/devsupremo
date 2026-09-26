import { z } from 'zod'
import { readProjectConfig } from './daemon'
import { scheduledFunctionScaffold, scheduledFunctionSlug, scheduledFunctionNames } from '../../../src/lib/database-jobs/function-contract'

/** Pure output for the agent to edit. Never overwrites application files. */
export function cronScaffold(cwd: string, raw: unknown) {
  const { slug } = z.object({ slug: scheduledFunctionSlug }).strict().parse(raw)
  const config = readProjectConfig(cwd)
  if (!config) throw new Error('Execute o bootstrap para identificar o projeto.')
  const projectId = z.string().uuid().parse(config.projectId)
  return { path: `supabase/functions/${slug}/index.ts`, source: scheduledFunctionScaffold(projectId, slug),
    environmentName: scheduledFunctionNames(projectId, slug).environment,
    implemented: false, message: 'Implemente a tarefa e sua idempotência no handler. Preserve a verificação de assinatura, publique a função e aplique supabase/jobs.json. O motor configura a assinatura; não solicite essa chave ao usuário.' }
}
