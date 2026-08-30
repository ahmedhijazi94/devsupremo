import { describe, it, expect } from 'vitest'
import { slugToBranch, SERVER_INSTRUCTIONS } from './server'

describe('slugToBranch', () => {
  it('usa o prefixo supremo/', () => {
    expect(slugToBranch('feat: adiciona login')).toMatch(/^supremo\//)
  })

  it('remove o prefixo de commit semântico', () => {
    expect(slugToBranch('feat: adiciona login')).toContain('adiciona-login')
    expect(slugToBranch('fix(auth): corrige sessão')).toContain(
      'corrige-sessao',
    )
  })

  it('remove acentos', () => {
    expect(slugToBranch('feat: configuração de opção')).toContain(
      'configuracao-de-opcao',
    )
  })

  it('não deixa caractere inválido para ref do git', () => {
    const branch = slugToBranch('feat: usuário & senha (v2)! 100%')
    expect(branch).toMatch(/^supremo\/[a-z0-9-]+$/)
  })

  it('não termina com hífen', () => {
    expect(slugToBranch('feat: teste ---')).not.toMatch(/-$/)
  })

  it('trunca resumo longo mas mantém a branch utilizável', () => {
    const branch = slugToBranch(`feat: ${'palavra '.repeat(30)}`)
    expect(branch.length).toBeLessThan(60)
    expect(branch).toMatch(/^supremo\/[a-z0-9-]+$/)
  })

  it('gera nomes diferentes para o mesmo resumo', async () => {
    const first = slugToBranch('feat: mesmo texto')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = slugToBranch('feat: mesmo texto')
    expect(first).not.toBe(second)
  })

  it('sobrevive a resumo sem nenhum caractere aproveitável', () => {
    expect(slugToBranch('!!!! ####')).toMatch(/^supremo\/change-/)
  })
})

describe('SERVER_INSTRUCTIONS', () => {
  // As regras viajam no handshake do MCP. Se alguma sumir daqui, o agente
  // deixa de recebê-la em toda máquina conectada.
  it.each([
    ['get_project_context', 'ler as regras do projeto'],
    ['propose_changes', 'único caminho de escrita'],
    ['wait_for_checks', 'esperar os gates'],
    ['merge_when_green', 'fechar o ciclo'],
    ['ENABLE ROW LEVEL SECURITY', 'exigir RLS'],
    ['auth.uid()', 'não confiar no cliente'],
    ['get_preview_errors', 'confirmar que a aplicação sobe'],
  ])('menciona %s (%s)', (needle) => {
    expect(SERVER_INSTRUCTIONS).toContain(needle)
  })

  it('deixa explícito que não se commita na branch principal', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/não commita na branch principal/i)
  })

  it('separa gate verde de aplicação que abre', () => {
    // São coisas diferentes, e confundir as duas foi o que fez o preview
    // ficar em branco sem ninguém perceber.
    expect(SERVER_INSTRUCTIONS).toMatch(/não que a aplicação abre/i)
  })
})
