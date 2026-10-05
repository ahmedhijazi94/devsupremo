import { sanitizeDiagnostic } from '../checkpoint/feedback'
import type { FunctionDeploy } from './contract'

/** This is deliberately a structural preview, not an export of deployable code.
 * Entire lines containing literals/comments/regexes are hidden, including their
 * multiline continuations. Vault/runtime values are never read for this view. */
export function functionSourceView(bundle: FunctionDeploy, version: number) {
  return { slug: bundle.slug, version, entrypoint: bundle.entrypoint, sanitized: true as const, exactSource: false as const,
    files: bundle.files.map(file => {
      let quoted = '', block = false, escaped = false, redacted = false
      const lines = file.content.split('\n').map(line => {
        let hide = Boolean(quoted || block)
        for (let index = 0; index < line.length; index++) {
          const char = line[index]!, next = line[index + 1]
          if (block) { if (char === '*' && next === '/') { block = false; index++ }; continue }
          if (quoted) {
            if (escaped) escaped = false
            else if (char === '\\') escaped = true
            else if (char === quoted) quoted = ''
            continue
          }
          if (char === '/' && next === '*') { block = true; hide = true; index++; continue }
          if (char === '/') { hide = true; break }
          if (['"', "'", '`'].includes(char)) { quoted = char; hide = true }
        }
        escaped = false
        if (hide) { redacted = true; return '[linha com valores ou comentários omitida]' }
        const sanitized = sanitizeDiagnostic(line, 16000)
        redacted ||= sanitized !== line
        return sanitized
      })
      const content = lines.join('\n')
      return { path: file.path, content: content.slice(0, 16000), truncated: content.length > 16000, redacted }
    }) }
}
