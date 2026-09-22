/** Framework identity is evidence, never permission to execute commands. */
export type ProjectStack = 'nextjs' | 'tanstack-start-vite'

export interface StackEvidence {
  dependencies?: Readonly<Record<string, unknown>>
  devDependencies?: Readonly<Record<string, unknown>>
  declaredStack?: unknown
  scaffoldVersion?: unknown
}

export function stackForVersion(version: unknown): ProjectStack | null {
  if (version === undefined || version === null || version === '') return null
  if (typeof version !== 'string') throw new Error('Versão de template inválida.')
  if (/^[1-4]\.\d+\.\d+$/.test(version)) return 'nextjs'
  if (version === '5.0.0') return 'tanstack-start-vite'
  throw new Error(`Versão de template não reconhecida: ${version}.`)
}

export function parseProjectStack(value: unknown): ProjectStack | null {
  if (value === undefined || value === null) return null
  if (value === 'nextjs' || value === 'tanstack-start-vite') return value
  throw new Error('Stack de projeto não reconhecida.')
}

/** Missing metadata never selects the default for new projects. */
export function resolveProjectStack(evidence: StackEvidence): ProjectStack | null {
  const declared = parseProjectStack(evidence.declaredStack)
  const versionStack = stackForVersion(evidence.scaffoldVersion)
  if (declared && versionStack && declared !== versionStack) {
    throw new Error('Stack e versão do template são incompatíveis.')
  }
  const has = (name: string): boolean =>
    typeof evidence.dependencies?.[name] === 'string' || typeof evidence.devDependencies?.[name] === 'string'
  const next = has('next')
  const start = has('@tanstack/react-start')
  if (next && start) throw new Error('Stack ambígua: Next.js e TanStack Start no mesmo projeto.')
  if (start && (!has('@tanstack/react-router') || !has('vite'))) {
    throw new Error('TanStack Start requer Router e Vite explícitos no projeto.')
  }
  const actual: ProjectStack | null = next ? 'nextjs' : start ? 'tanstack-start-vite' : null
  const expected = declared ?? versionStack
  if (expected && actual !== expected) throw new Error('A stack declarada não corresponde às dependências do projeto.')
  return actual
}
