/**
 * Redação de secrets nos logs locais. O companion loga install/dev/git na
 * máquina do dev; nada de token/segredo pode vazar pro arquivo de log nem pro
 * que sobe ao Supremo. Puro e testável.
 */

// Padrões de coisas que NUNCA devem aparecer em log.
const PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /sup_[A-Za-z0-9_-]{10,}/g, label: 'sup_***' }, // token do Supremo
  { re: /gh[posru]_[A-Za-z0-9]{20,}/g, label: 'gh_***' }, // tokens do GitHub
  { re: /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, label: 'jwt_***' }, // JWT
  { re: /sbp_[A-Za-z0-9]{20,}/g, label: 'sbp_***' }, // token do Supabase
  // Authorization: Bearer xxxxx
  { re: /(authorization:\s*bearer\s+)\S+/gi, label: '$1***' },
  // chaves em URL: ?token=xxx, ?key=xxx, &access_token=xxx
  { re: /([?&](?:token|key|access_token|apikey|secret)=)[^&\s]+/gi, label: '$1***' },
]

/** Troca qualquer secret conhecido por um marcador. Idempotente. */
export function redact(text: string): string {
  let out = text
  for (const { re, label } of PATTERNS) {
    out = out.replace(re, label)
  }
  return out
}

/**
 * Redação extra: valores sensíveis conhecidos em runtime (o próprio token do
 * companion, cloneToken, etc.) mascarados por igualdade exata. Complementa os
 * padrões — pega segredos que não casam com um formato conhecido.
 */
export function redactWith(text: string, secrets: Array<string | null | undefined>): string {
  let out = redact(text)
  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      out = out.split(secret).join('***')
    }
  }
  return out
}
