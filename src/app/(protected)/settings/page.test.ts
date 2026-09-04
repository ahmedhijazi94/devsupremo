import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regressão (limpeza de UI — v3.4): a tela de Configurações tinha um card
 * "Tokens de MCP" (→ `/mcps`) e mencionava tokens de MCP no aviso de logout —
 * ambos apontavam pra uma tela que não existe mais (arquitetura antiga). A
 * tabela `mcp_tokens`/RLS no backend continuam intactas; só a UI saiu.
 */
describe('SettingsPage — nenhuma referência visível a MCP/tela removida (v3.4)', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'page.tsx')
  const source = readFileSync(file, 'utf8')

  it('nenhum link/texto aponta pra /mcps', () => {
    expect(source).not.toMatch(/href=['"]\/mcps['"]/)
    expect(source).not.toContain('Tokens de MCP')
    expect(source).not.toContain('Integração MCP')
  })

  it('a lista de integrações continua com "Contas conectadas" (a limpeza não removeu o resto)', () => {
    expect(source).toContain('Contas conectadas')
    expect(source).toMatch(/href:\s*'\/accounts'/)
  })
})
