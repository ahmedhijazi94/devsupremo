/** CodeQL is an additional provider gate, never a replacement for our CI jobs. */
export interface CodeScanningEvidence {
  headSha: string
  status: 'passed' | 'not_required' | 'pending' | 'failed' | 'unavailable'
  reasons: string[]
}

export interface CodeScanningCheck {
  id: number
  name: string
  head_sha: string
  status: string
  conclusion: string | null
  app: { id: number; slug?: string; owner?: { login?: string } | null } | null
}

export interface CodeScanningRepository {
  private: boolean
  security_and_analysis?: {
    code_security?: { status?: string }
    advanced_security?: { status?: string }
  } | null
}

export interface CodeScanningPort {
  listChecks(headSha: string): Promise<CodeScanningCheck[]>
  getDefaultSetup(): Promise<{ state?: string }>
  getRepository(): Promise<CodeScanningRepository>
}

export function evaluateCodeScanning(
  headSha: string,
  checks: readonly CodeScanningCheck[],
  setup: 'configured' | 'not-configured' | 'unlicensed' | 'unavailable',
): CodeScanningEvidence {
  // Name alone is attacker controlled. Only GitHub's own security application
  // may provide this gate; obsolete revisions and other publishers cannot help.
  const latest = checks.filter(check => check.head_sha === headSha && check.name === 'CodeQL'
    && check.app?.id === 57789 && check.app.slug === 'github-advanced-security'
    && check.app.owner?.login === 'github')
    .sort((a, b) => b.id - a.id)[0]
  if (latest && latest.status !== 'completed') {
    return { headSha, status: 'pending', reasons: ['CodeQL oficial ainda está em execução nesta revisão.'] }
  }
  if (latest && latest.conclusion !== 'success') {
    return { headSha, status: 'failed', reasons: ['CodeQL oficial não aprovou esta revisão.'] }
  }
  if (setup === 'unavailable') {
    return { headSha, status: 'unavailable', reasons: ['Não foi possível comprovar a configuração do CodeQL; integração suspensa.'] }
  }
  if (latest) return { headSha, status: 'passed', reasons: ['CodeQL oficial aprovado nesta revisão.'] }
  if (setup === 'configured') {
    return { headSha, status: 'pending', reasons: ['CodeQL está configurado, mas ainda não publicou o resultado desta revisão.'] }
  }
  return { headSha, status: 'not_required', reasons: [setup === 'unlicensed'
    ? 'CodeQL indisponível: o GitHub confirmou Code Security e Advanced Security desativados neste repositório privado.'
    : 'O GitHub confirmou que o default setup do CodeQL não está configurado.'] }
}

export async function readCodeScanning(port: CodeScanningPort, headSha: string): Promise<CodeScanningEvidence> {
  const [checks, configuration] = await Promise.allSettled([port.listChecks(headSha), port.getDefaultSetup()])
  if (checks.status === 'rejected') {
    return { headSha, status: 'unavailable', reasons: ['Não foi possível consultar os checks oficiais do CodeQL; integração suspensa.'] }
  }
  let setup: Parameters<typeof evaluateCodeScanning>[2] = 'unavailable'
  if (configuration.status === 'fulfilled') {
    if (configuration.value.state === 'configured' || configuration.value.state === 'not-configured') setup = configuration.value.state
  } else {
    const error: unknown = configuration.reason
    const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined
    if (status === 403 || status === 404) {
      // A 404 can conceal missing permissions. It never proves that CodeQL is
      // optional. Only positive repository feature metadata permits this case.
      try {
        const repo = await port.getRepository()
        if (repo.private && repo.security_and_analysis?.code_security?.status === 'disabled'
          && repo.security_and_analysis.advanced_security?.status === 'disabled') setup = 'unlicensed'
      } catch { setup = 'unavailable' }
    }
  }
  return evaluateCodeScanning(headSha, checks.value, setup)
}
