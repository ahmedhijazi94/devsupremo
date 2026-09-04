import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regressão (limpeza de UI — v3.4): a aba "MCP" do header saiu da navegação
 * principal — arquitetura antiga, o fluxo hoje é bootstrap/checkpoint local.
 * `TopNav` e `MobileNav` compartilham o MESMO array `NAV`, então um teste só
 * cobre os dois. O backend (`/api/mcp`) e a tabela `mcp_tokens` continuam
 * intactos — só a navegação pra tela de configuração saiu.
 */
describe('TopNav/MobileNav — a aba MCP não faz mais parte da navegação principal (v3.4)', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'top-nav.tsx')
  const source = readFileSync(file, 'utf8')

  it('nenhum item de navegação aponta pra /mcps', () => {
    expect(source).not.toContain("href: '/mcps'")
    expect(source).not.toMatch(/href=['"]\/mcps['"]/)
  })

  it('o rótulo "MCP" não existe mais na lista de navegação', () => {
    expect(source).not.toMatch(/label:\s*'MCP'/)
  })

  it('os outros destinos da navegação continuam intactos (a limpeza não removeu nada além do MCP)', () => {
    for (const href of ['/dashboard', '/projects', '/accounts', '/settings']) {
      expect(source).toContain(`href: '${href}'`)
    }
  })
})
