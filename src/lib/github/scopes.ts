/**
 * Scopes OAuth do GitHub que o Supremo precisa — FONTE ÚNICA (usada tanto na hora
 * de pedir o OAuth quanto para detectar conexões antigas que precisam reautorizar).
 *
 * `read:org` é o que faltava: sem ele, `GET /user/orgs` não lista as organizações
 * do usuário, então nenhuma org (ex.: Hijaziia) entra na interseção de owners.
 * Os demais são os já necessários (criar/apagar repo, workflow, identidade).
 */
export const GITHUB_OAUTH_SCOPES = [
  'repo',
  'read:user',
  'user:email',
  'delete_repo',
  'workflow',
  'read:org',
] as const

/** String pronta para o parâmetro `scope` da URL de authorize. */
export const GITHUB_OAUTH_SCOPE_STRING = GITHUB_OAUTH_SCOPES.join(',')

/** Scope que habilita listar/escolher organização como owner. */
export const ORG_SCOPE = 'read:org'

/**
 * Uma conexão GitHub existente precisa RECONECTAR se lhe falta algum scope
 * requerido (ex.: a conta antiga sem `read:org`). `admin:org` satisfaz `read:org`.
 * Nunca fingimos que a conexão está completa — o chamador sinaliza reconexão.
 */
export function accountNeedsReconnect(
  scopes: readonly string[] | null | undefined,
): boolean {
  const have = new Set(scopes ?? [])
  return GITHUB_OAUTH_SCOPES.some((required) => {
    if (have.has(required)) return false
    // admin:org implica read:org
    if (required === 'read:org' && have.has('admin:org')) return false
    return true
  })
}
