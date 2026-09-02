import { describe, expect, it } from 'vitest'
import { isKnownOrGlobal, unknownCommandMessage, KNOWN_COMMANDS } from './command-guard'

describe('guard de comando desconhecido — nunca cai silenciosamente na ponte MCP', () => {
  it('comandos reais são reconhecidos', () => {
    for (const c of KNOWN_COMMANDS) expect(isKnownOrGlobal(c)).toBe(true)
  })
  it('sem args (uso normal do default mcp) é permitido', () => {
    expect(isKnownOrGlobal(undefined)).toBe(true)
  })
  it('opção global (--version/--help) é permitida', () => {
    expect(isKnownOrGlobal('--version')).toBe(true)
    expect(isKnownOrGlobal('-V')).toBe(true)
  })
  it('comando desconhecido (typo ou CLI desatualizada) é REJEITADO', () => {
    expect(isKnownOrGlobal('checkpoint-x')).toBe(false)
    expect(isKnownOrGlobal('publish')).toBe(false)
  })
  it('a mensagem explica o comando e sugere versão desatualizada', () => {
    const msg = unknownCommandMessage('checkpoint')
    expect(msg).toContain('checkpoint')
    expect(msg).toMatch(/desatualizada/i)
    expect(msg).toContain('supremo-cli@latest')
    // nunca deixa o usuário pensar que é um erro de SUPREMO_URL (bridge MCP)
    expect(msg).not.toMatch(/SUPREMO_URL/)
  })
})
