import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regressão (tela do projeto — scroll vertical): Histórico e Atividade
 * costumavam viver dentro de uma caixa `max-h-[60vh]` com scroll INTERNO
 * (`overflow-y-auto`) — uma gambiarra que compensava o `WorkspaceLayout`
 * travando a rolagem da página (ver `../layout.test.ts`). Com a página
 * rolando normalmente de novo, essa caixa interna some: as duas seções
 * crescem com o conteúdo, como qualquer outro cartão da página — nunca uma
 * altura máxima com scroll próprio. Lê o arquivo de verdade — não
 * reimplementa a checagem em memória.
 */
function classTokens(source: string): string[] {
  const tokens: string[] = []
  for (const m of source.matchAll(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g)) {
    const value = m[1] ?? m[2] ?? m[3] ?? ''
    tokens.push(...value.split(/\s+/).filter(Boolean))
  }
  return tokens
}

describe('Página do projeto — Histórico/Atividade nunca ficam presos num scroll interno', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'page.tsx')
  const source = readFileSync(file, 'utf8')
  const tokens = classTokens(source)

  it('nenhuma altura máxima de viewport (max-h-[60vh] ou equivalente) na página', () => {
    expect(tokens.some((t) => /^max-h-\[/.test(t))).toBe(false)
  })

  it('nenhum `overflow-y-auto`/`overflow-hidden` na página — quem rola é a página inteira', () => {
    expect(tokens).not.toContain('overflow-y-auto')
    expect(tokens).not.toContain('overflow-hidden')
  })

  it('Histórico e Atividade continuam presentes (a limpeza não removeu as seções)', () => {
    expect(source).toContain('CheckpointHistory')
    expect(source).toContain('ActivityFeed')
  })
})

/**
 * Regressão (header sticky): o cabeçalho principal (nome/status/excluir)
 * fica fixo no topo durante o scroll — sem criar NENHUM scroll interno (essa
 * é exatamente a regressão que o bloco acima já protege; este teste garante
 * que a mudança do header não a reintroduz).
 */
describe('Página do projeto — cabeçalho principal fica sticky, sem criar scroll interno', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'page.tsx')
  const source = readFileSync(file, 'utf8')
  const tokens = classTokens(source)

  it('o <header> usa `sticky` com um `top` definido (fica visível durante o scroll)', () => {
    const headerMatch = /<header\s+className=(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/.exec(source)
    expect(headerMatch).not.toBeNull()
    const headerClasses = (headerMatch![1] ?? headerMatch![2] ?? headerMatch![3] ?? '').split(/\s+/)
    expect(headerClasses).toContain('sticky')
    expect(headerClasses.some((t) => /^top-\d/.test(t))).toBe(true)
    expect(headerClasses.some((t) => /^z-\d/.test(t))).toBe(true)
  })

  it('continua sem `max-h-[...]`/`overflow-y-auto`/`overflow-hidden` em lugar nenhum — sticky não é scroll interno', () => {
    expect(tokens.some((t) => /^max-h-\[/.test(t))).toBe(false)
    expect(tokens).not.toContain('overflow-y-auto')
    expect(tokens).not.toContain('overflow-hidden')
  })
})
