import { describe, expect, it } from 'vitest'
import { functionSourceView } from './source-view'
import type { FunctionDeploy } from './contract'
const bundle: FunctionDeploy = { slug: 'mail', environment: 'development', entrypoint: 'supabase/functions/mail/index.ts', verifyJwt: false, files: [] }
describe('protected function source preview', () => {
  it('shows structure but hides literal, comment, template and regex values, including multiline continuations', () => {
    const content = [
      'export async function handler(request) {', 'const password = "top-secret"', 'const body = `', 'multiline-secret', '`',
      '/* comment-secret', 'nested "secret"', '*/', '// one-line-secret', 'const pattern = /embedded-secret/', "const escaped = 'a\\\'b'", 'return request', '}',
    ].join('\n')
    const result = functionSourceView({ ...bundle, files: [{ path: bundle.entrypoint, content }] }, 2)
    expect(result).toMatchObject({ version: 2, sanitized: true, exactSource: false })
    expect(result.files[0]?.content).toContain('export async function handler(request)')
    expect(result.files[0]?.content).toContain('return request')
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(result.files[0]?.redacted).toBe(true)
  })
  it('bounds previews and reports truncation while applying credential diagnostic patterns to bare tokens', () => {
    const result = functionSourceView({ ...bundle, files: [{ path: bundle.entrypoint, content: 'ghp_PRIVATEFIXTURE\n' + 'return value;\n'.repeat(2000) }] }, 1)
    expect(result.files[0]?.content).not.toContain('PRIVATEFIXTURE')
    expect(result.files[0]?.content.length).toBe(16000)
    expect(result.files[0]?.truncated).toBe(true)
    expect(functionSourceView({ ...bundle, files: [{ path: bundle.entrypoint, content: 'return value' }] }, 1).files[0]?.redacted).toBe(false)
  })
})
