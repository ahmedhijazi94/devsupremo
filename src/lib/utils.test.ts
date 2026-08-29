import { describe, it, expect } from 'vitest'
import {
  cn,
  formatDate,
  formatRelativeTime,
  truncate,
  generateSlug,
} from './utils'

describe('cn', () => {
  it('junta classes', () => {
    expect(cn('px-2', 'py-1')).toBe('px-2 py-1')
  })

  it('resolve conflito do Tailwind mantendo a última', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4')
  })

  it('ignora valores falsos', () => {
    expect(cn('px-2', false, null, undefined, '', 'py-1')).toBe('px-2 py-1')
  })

  it('aceita condicional em objeto', () => {
    expect(cn({ 'text-red-500': true, 'text-blue-500': false })).toBe(
      'text-red-500'
    )
  })

  it('aceita array aninhado', () => {
    expect(cn(['px-2', ['py-1']])).toBe('px-2 py-1')
  })

  it('sem argumento devolve string vazia', () => {
    expect(cn()).toBe('')
  })
})

describe('formatDate', () => {
  it('formata data e hora em pt-BR', () => {
    // Formato dd/mm/aaaa, hh:mm — o horário depende do fuso do runner,
    // então a asserção é sobre a forma, não sobre o valor da hora.
    expect(formatDate('2026-03-09T14:30:00')).toMatch(
      /^09\/03\/2026,? \d{2}:\d{2}$/
    )
  })

  it('aceita objeto Date', () => {
    expect(formatDate(new Date('2026-12-25T10:00:00'))).toMatch(
      /^25\/12\/2026,? \d{2}:\d{2}$/
    )
  })
})

describe('formatRelativeTime', () => {
  it('menos de um minuto vira "agora"', () => {
    expect(formatRelativeTime(new Date(Date.now() - 30_000))).toBe('agora')
  })

  it('minutos', () => {
    expect(formatRelativeTime(new Date(Date.now() - 5 * 60_000))).toBe('5m atrás')
  })

  it('horas', () => {
    expect(formatRelativeTime(new Date(Date.now() - 3 * 3_600_000))).toBe(
      '3h atrás'
    )
  })

  it('dias', () => {
    expect(formatRelativeTime(new Date(Date.now() - 3 * 86_400_000))).toBe(
      '3d atrás'
    )
  })

  it('acima de uma semana cai para data absoluta', () => {
    const antigo = new Date(Date.now() - 30 * 86_400_000)
    expect(formatRelativeTime(antigo)).toMatch(/^\d{2}\/\d{2}\/\d{4}/)
  })
})

describe('truncate', () => {
  it('mantém string curta intacta', () => {
    expect(truncate('curto', 10)).toBe('curto')
  })

  it('corta e adiciona reticências', () => {
    expect(truncate('uma frase bem longa', 8)).toBe('uma fras...')
  })

  it('não corta no limite exato', () => {
    expect(truncate('exato', 5)).toBe('exato')
  })

  it('aceita string vazia', () => {
    expect(truncate('', 5)).toBe('')
  })
})

describe('generateSlug', () => {
  it('minúsculas com hífen', () => {
    expect(generateSlug('Meu Projeto')).toBe('meu-projeto')
  })

  it('colapsa separadores repetidos', () => {
    expect(generateSlug('a   b___c')).toBe('a-b-c')
  })

  it('remove hífen das pontas', () => {
    expect(generateSlug('  --Projeto--  ')).toBe('projeto')
  })

  it('preserva números', () => {
    expect(generateSlug('App v2 2026')).toBe('app-v2-2026')
  })

  it('string só de símbolos vira vazia', () => {
    expect(generateSlug('!@#$%')).toBe('')
  })
})
