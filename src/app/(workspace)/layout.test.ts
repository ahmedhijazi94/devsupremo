import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regressão (tela do projeto — scroll vertical): `WorkspaceLayout` é o único
 * ancestral da rota `/projects/[id]` além do `RootLayout`. Um `h-screen` (a
 * altura EXATA da viewport, nunca menos) combinado com `overflow-hidden`
 * aqui trava a rolagem da PÁGINA inteira — o Histórico/Atividade ficam
 * cortados sem como chegar ao fim, mesmo a página crescendo normalmente.
 * Isso já aconteceu uma vez (resíduo de quando esta rota hospedava um
 * preview/IDE de altura fixa); este teste lê o arquivo de verdade — não
 * reimplementa a checagem em memória — pra nunca reaparecer OU IN sozinho.
 *
 * Checagem por TOKEN de classe (não substring): `min-h-screen` é permitido
 * e desejado (cresce com o conteúdo); só o token EXATO `h-screen` é proibido
 * — uma checagem ingênua por substring acusaria `min-h-screen` também.
 */
function classTokens(source: string): string[] {
  const tokens: string[] = []
  for (const m of source.matchAll(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g)) {
    const value = m[1] ?? m[2] ?? m[3] ?? ''
    tokens.push(...value.split(/\s+/).filter(Boolean))
  }
  return tokens
}

describe('WorkspaceLayout (rota do projeto) — nunca trava o scroll vertical da página', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'layout.tsx')
  const source = readFileSync(file, 'utf8')
  const tokens = classTokens(source)

  it('não usa o token de classe `h-screen` (min-h-screen é permitido)', () => {
    expect(tokens).not.toContain('h-screen')
  })

  it('não usa `overflow-hidden` no wrapper — nada aqui pode bloquear a rolagem da página', () => {
    expect(tokens).not.toContain('overflow-hidden')
  })

  it('sanity: o extrator de tokens realmente separa min-h-screen de h-screen', () => {
    // guarda o PRÓPRIO teste: se isso falhasse, os dois testes acima
    // poderiam estar "passando" por acidente (bug no extrator, não no layout).
    expect(classTokens('<div className="bg-canvas min-h-screen">')).toEqual([
      'bg-canvas',
      'min-h-screen',
    ])
    expect(classTokens('<div className="bg-canvas min-h-screen">')).not.toContain('h-screen')
  })
})
