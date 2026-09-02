import { describe, expect, it, vi } from 'vitest'
import { ensureAuthorized, type AuthIO } from './auth'

function fakeIO(): AuthIO & { oks: string[]; prompts: string[] } {
  const oks: string[] = []
  const prompts: string[] = []
  return {
    oks,
    prompts,
    ok: (m) => oks.push(m),
    info: () => {},
    waitForEnter: async (m) => {
      prompts.push(m)
    },
  }
}

describe('ensureAuthorized (Auth Orchestrator)', () => {
  it('já autorizado → segue SEM interação nem authorize', async () => {
    const io = fakeIO()
    const authorize = vi.fn()
    const ok = await ensureAuthorized(
      { name: 'Supabase', isAuthorized: () => true, authorize },
      io,
    )
    expect(ok).toBe(true)
    expect(authorize).not.toHaveBeenCalled()
    expect(io.prompts).toEqual([]) // nenhum "Pressione ENTER"
    expect(io.oks).toEqual(['Supabase autorizado'])
  })

  it('precisa autorizar → mostra o prompt, autoriza e detecta o sucesso', async () => {
    const io = fakeIO()
    let authorized = false
    const ok = await ensureAuthorized(
      {
        name: 'Supabase',
        isAuthorized: () => authorized,
        authorize: () => {
          authorized = true // simula o login oficial concluído
        },
      },
      io,
    )
    expect(ok).toBe(true)
    expect(io.prompts).toHaveLength(1)
    expect(io.prompts[0]).toContain('Pressione ENTER')
    expect(io.oks).toEqual(['Supabase autorizado'])
  })

  it('usa o prompt customizado do provider (ex.: Supremo)', async () => {
    const io = fakeIO()
    await ensureAuthorized(
      {
        name: 'Supremo',
        prompt: 'Supremo precisa autorizar esta máquina. Pressione ENTER para continuar…',
        isAuthorized: () => false,
        authorize: () => {},
      },
      io,
    )
    expect(io.prompts[0]).toBe(
      'Supremo precisa autorizar esta máquina. Pressione ENTER para continuar…',
    )
  })

  it('se o fluxo não autorizar → retorna false e NÃO marca ✓', async () => {
    const io = fakeIO()
    const ok = await ensureAuthorized(
      { name: 'Supabase', isAuthorized: () => false, authorize: () => {} },
      io,
    )
    expect(ok).toBe(false)
    expect(io.oks).toEqual([])
  })

  it('não re-pede autorização quando a credencial válida já existe', async () => {
    const io = fakeIO()
    const authorize = vi.fn()
    await ensureAuthorized(
      { name: 'Supremo', isAuthorized: () => true, authorize },
      io,
    )
    expect(authorize).not.toHaveBeenCalled()
    expect(io.prompts).toEqual([])
  })
})
