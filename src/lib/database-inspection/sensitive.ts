/** One policy for SQL projections, JSON redaction and schema defaults. A field
 * hidden in structured output must not escape via `AS harmless_name`. */
export const SENSITIVE_IDENTIFIER_PATTERN =
  'password|passwd|secret|credential|token|api[_-]?key|private[_-]?key|authorization|cookie|connection[_-]?string|encrypted|hash'
const sensitiveIdentifier = new RegExp(SENSITIVE_IDENTIFIER_PATTERN, 'i')
export function isSensitiveIdentifier(name: string): boolean {
  return sensitiveIdentifier.test(name)
}
