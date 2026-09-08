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
    ? 'CodeQL não aplicável: o GitHub confirmou Code Security desativado neste repositório privado. Os gates obrigatórios do projeto continuam exigidos; isto não é aprovação do CodeQL.'
    : 'O GitHub confirmou que o default setup do CodeQL não está configurado.'] }
}

/** Modern personal/private repositories can omit the legacy Advanced Security
 * field. A missing field alone is never a license exception: require the exact
 * provider refusal as well as explicit disabled Code Security metadata. */
function confirmsDisabledCodeSecurity(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error) || error.status !== 403) return false
  let message: unknown = 'message' in error ? error.message : undefined
  if ('response' in error && typeof error.response === 'object' && error.response !== null && 'data' in error.response) {
    const data: unknown = error.response.data
    if (typeof data === 'object' && data !== null && 'message' in data) message = data.message
  }
  return message === 'Code Security must be enabled for this repository to use code scanning.'
    || message === 'GitHub Code Security or GitHub Advanced Security must be enabled for this repository to use code scanning.'
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
        const features = repo.security_and_analysis
        const legacyDisabled = features?.advanced_security?.status === 'disabled'
        const modernDisabled = features?.advanced_security === undefined && confirmsDisabledCodeSecurity(error)
        if (repo.private && features?.code_security?.status === 'disabled'
          && (legacyDisabled || modernDisabled)) setup = 'unlicensed'
      } catch { setup = 'unavailable' }
    }
  }
  return evaluateCodeScanning(headSha, checks.value, setup)
}
