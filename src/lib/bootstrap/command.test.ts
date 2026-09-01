import { describe, expect, it } from 'vitest'
import { bootstrapCommand } from './command'

describe('bootstrapCommand', () => {
  it('monta o comando com project-id e url', () => {
    expect(bootstrapCommand('proj-123', 'https://supremo.app')).toBe(
      'npx @supremo/cli@latest bootstrap proj-123 --url https://supremo.app',
    )
  })

  it('remove a barra final da url', () => {
    expect(bootstrapCommand('p', 'https://x.com/')).toBe(
      'npx @supremo/cli@latest bootstrap p --url https://x.com',
    )
  })

  it('não embute segredo — só o project-id', () => {
    const cmd = bootstrapCommand('abc', 'http://localhost:3000')
    expect(cmd).not.toMatch(/token|secret|sup_/)
    expect(cmd).toContain('abc')
  })
})
