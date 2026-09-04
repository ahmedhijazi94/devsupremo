import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regressão (limpeza de UI — v3.4): o estado vazio de "Últimas mudanças"
 * mandava o usuário pra `/mcps` ("Conecte um agente em MCP") — uma tela que
 * não existe mais (arquitetura antiga). Aponta pra `/projects` em vez disso.
 */
describe('DashboardPage — estado vazio de mudanças não aponta mais pra /mcps (v3.4)', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'page.tsx')
  const source = readFileSync(file, 'utf8')

  it('nenhum link/texto aponta pra /mcps', () => {
    expect(source).not.toMatch(/href=['"]\/mcps['"]/)
    expect(source).not.toContain('Conecte um agente em')
  })

  it('o estado vazio continua orientando o próximo passo (agora via /projects)', () => {
    expect(source).toMatch(/href=['"]\/projects['"]/)
    expect(source).toContain('primeira alteração')
  })
})
