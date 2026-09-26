import { z } from 'zod'

/** Allowlisted metadata only: raw logs, test paths and prompts stay on the device. */
export const localDiagnosticCodeSchema = z.enum([
  'acceptance_test_path', 'acceptance_contract', 'validation_integrity',
  'typecheck', 'lint', 'build', 'tests', 'security', 'rls', 'migration',
  'environment', 'infrastructure', 'validation',
  'typecheck_timeout', 'lint_timeout', 'build_timeout', 'tests_timeout',
  'security_timeout', 'rls_timeout', 'validation_timeout', 'validation_interrupted',
])
export type LocalDiagnosticCode = z.infer<typeof localDiagnosticCodeSchema>

export interface LocalDiagnosticPresentation {
  stage: string
  cause: string
  nextStep: string
}

const PRESENTATION: Record<LocalDiagnosticCode, Omit<LocalDiagnosticPresentation, 'nextStep'>> = {
  acceptance_test_path: { stage: 'Contrato de testes', cause: 'O motor rejeitou um caminho de teste (Test path must name a project test), antes de executar os testes.' },
  acceptance_contract: { stage: 'Contrato de testes', cause: 'O contrato de aceitação ou um dos arquivos de prova foi rejeitado pelo motor.' },
  validation_integrity: { stage: 'Integridade da validação', cause: 'Os arquivos que executam a validação divergem da base autorizada.' },
  typecheck: { stage: 'Verificação de tipos', cause: 'A verificação de TypeScript encontrou erros nesta versão.' },
  lint: { stage: 'Análise do código', cause: 'A análise estática encontrou erros nesta versão.' },
  build: { stage: 'Compilação', cause: 'A compilação desta versão falhou.' },
  tests: { stage: 'Testes do app', cause: 'Um ou mais testes desta versão falharam.' },
  security: { stage: 'Segurança', cause: 'A verificação de segurança encontrou uma pendência que impede o envio.' },
  rls: { stage: 'Isolamento de dados', cause: 'A verificação de permissões e isolamento dos dados falhou.' },
  migration: { stage: 'Alterações do banco', cause: 'A verificação das alterações do banco falhou.' },
  environment: { stage: 'Ambiente de desenvolvimento', cause: 'Uma configuração necessária do ambiente impediu a validação.' },
  infrastructure: { stage: 'Infraestrutura de validação', cause: 'O motor não conseguiu concluir a execução das verificações locais.' },
  validation: { stage: 'Validação local', cause: 'A validação desta versão falhou; o diagnóstico completo permanece nos registros locais do motor.' },
  typecheck_timeout: { stage: 'Verificação de tipos', cause: 'A verificação de tipos excedeu o tempo disponível. Isso não confirma um erro de TypeScript.' },
  lint_timeout: { stage: 'Análise do código', cause: 'A análise do código excedeu o tempo disponível e não chegou a uma conclusão.' },
  build_timeout: { stage: 'Compilação', cause: 'A compilação excedeu o tempo disponível e não chegou a uma conclusão.' },
  tests_timeout: { stage: 'Testes do app', cause: 'A execução dos testes excedeu o tempo disponível. Os resultados parciais não aprovam esta versão.' },
  security_timeout: { stage: 'Segurança', cause: 'A verificação de segurança excedeu o tempo disponível e permanece pendente.' },
  rls_timeout: { stage: 'Isolamento de dados', cause: 'A verificação de isolamento excedeu o tempo disponível e permanece pendente.' },
  validation_timeout: { stage: 'Validação local', cause: 'A validação excedeu o tempo disponível. Os resultados parciais foram preservados, mas não aprovam esta versão.' },
  validation_interrupted: { stage: 'Validação local', cause: 'A execução foi interrompida antes de concluir. Os resultados parciais não aprovam esta versão.' },
}

export function presentLocalDiagnostic(code: LocalDiagnosticCode): LocalDiagnosticPresentation {
  const pending = code.endsWith('_timeout') || code === 'validation_interrupted'
  return { ...PRESENTATION[code], nextStep: pending
    ? 'Publicação aguarda a conclusão de uma nova validação. Você pode continuar desenvolvendo no preview.'
    : 'Publicação aguarda correção e nova validação. Você pode continuar desenvolvendo no preview.' }
}

/** Derivation cannot turn source-controlled text into transmitted text or approval. */
export function inferLocalDiagnostic(evidence: {
  logs: string; checks: readonly { name: string; status: string; type?: string | undefined; failureReason?: string | undefined }[]
}): LocalDiagnosticCode {
  if (evidence.logs.includes('Test path must name a project test')) return 'acceptance_test_path'
  const failed = evidence.checks.filter((check) => check.status === 'failed')
  if (failed.some((check) => check.name === 'acceptance contract')) return 'acceptance_contract'
  if (failed.some((check) => check.name === 'validation integrity')) return 'validation_integrity'
  // A concrete failure takes precedence over a parallel timed-out check. Stage
  // names remain an allowlist: private test names/logs never become panel text.
  const concrete = failed.find(check => !['timeout', 'interrupted', 'transient_infrastructure'].includes(check.failureReason ?? ''))
  if (!concrete) {
    const timeout = failed.find(check => check.failureReason === 'timeout')
    if (timeout) {
      const types: Record<string, LocalDiagnosticCode> = { typecheck: 'typecheck_timeout', lint: 'lint_timeout', build: 'build_timeout', unit: 'tests_timeout', integration: 'tests_timeout', e2e: 'tests_timeout', security: 'security_timeout', rls: 'rls_timeout' }
      const names: Record<string, LocalDiagnosticCode> = { 'geração de rotas': 'typecheck_timeout', typecheck: 'typecheck_timeout', lint: 'lint_timeout', build: 'build_timeout', 'testes afetados': 'tests_timeout', 'unit + integração': 'tests_timeout', 'browser e2e': 'tests_timeout', 'secret scan': 'security_timeout', 'rls / isolamento': 'rls_timeout' }
      return (Object.hasOwn(types, timeout.type ?? '') ? types[timeout.type ?? ''] : undefined)
        ?? (Object.hasOwn(names, timeout.name) ? names[timeout.name] : undefined) ?? 'validation_timeout'
    }
    if (failed.some(check => check.failureReason === 'interrupted')) return 'validation_interrupted'
  }
  const type = (concrete ?? failed[0])?.type
  switch (type) {
    case 'typecheck': case 'lint': case 'build': case 'security': case 'rls': case 'migration': case 'environment': return type
    case 'unit': case 'integration': case 'e2e': return 'tests'
    case 'external_dependency': return 'infrastructure'
    default: return 'validation'
  }
}

export const storedLocalDiagnosticSchema = z.object({
  source: z.literal('local'), version: z.literal(1),
  projectId: z.string().uuid(), checkpointId: z.string().uuid(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  revision: z.number().int().positive(), code: localDiagnosticCodeSchema,
}).strict()

/** Reject stale status/diagnostics, and never confuse this metadata with CI evidence. */
export function readLocalDiagnostic(raw: unknown, current: {
  projectId: unknown; checkpointId: unknown; commitSha: unknown; revision: unknown; validationStatus: unknown
}): LocalDiagnosticPresentation | undefined {
  const parsed = storedLocalDiagnosticSchema.safeParse(raw)
  if (!parsed.success || current.validationStatus !== 'failed' || parsed.data.projectId !== current.projectId || parsed.data.checkpointId !== current.checkpointId || parsed.data.commitSha !== current.commitSha || parsed.data.revision !== current.revision) return undefined
  return presentLocalDiagnostic(parsed.data.code)
}
