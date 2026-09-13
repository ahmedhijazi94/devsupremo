import { sanitizeDiagnostic, type ValidationFeedback } from './feedback'

/** Prefer the agent's description; file names are an honest fallback, not an invented feature. */
export function checkpointTitle(summary: string | undefined, paths: readonly string[] = []): string {
  const title = sanitizeDiagnostic(summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 180)
  if (title && !/^(?:unidade de trabalho|checkpoint remoto)$/i.test(title)) return title
  const files = [...new Set(paths)].filter(file => !file.startsWith('.supremo/'))
  const names = files.slice(0, 2).map(file => sanitizeDiagnostic(file).slice(0, 65))
  return names.length ? `Alterações em ${names.join(', ')}${files.length > 2 ? ` e mais ${files.length - 2} arquivos` : ''}`.slice(0, 180)
    : 'Alteração sem descrição'
}

/** Integration of a PR does not retroactively validate every intermediate snapshot. */
export function checkpointValidationSummary(integrated: boolean, feedback: ValidationFeedback | null): string {
  if (!integrated) return feedback?.summary ?? ''
  return feedback?.state === 'integrated' || feedback?.state === 'passed'
    ? 'Versão validada e integrada.'
    : 'Alteração incluída na integração do conjunto. A validação foi concluída na versão final.'
}

export function postMergeBadge(integrated: boolean, state: 'pending' | 'passed' | 'failed'): string | undefined {
  if (!integrated) return undefined
  return state === 'pending' ? 'Integrado — verificações finais em andamento'
    : state === 'failed' ? 'Integrado — falha nas verificações finais' : 'Integrado — testes aprovados'
}
