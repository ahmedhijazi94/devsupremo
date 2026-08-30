import { describe, it, expect } from 'vitest'
import { decodeState } from './oauth-state'

const validCsrf = 'a'.repeat(64)

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

describe('decodeState', () => {
  it('decodifica um state válido', () => {
    const state = encode({ csrf: validCsrf, projectId: 'abc' })
    expect(decodeState(state)).toEqual({ csrf: validCsrf, projectId: 'abc' })
  })

  it('aceita projectId nulo', () => {
    const state = encode({ csrf: validCsrf, projectId: null })
    expect(decodeState(state)?.projectId).toBeNull()
  })

  it('normaliza projectId de tipo inesperado para null', () => {
    const state = encode({ csrf: validCsrf, projectId: { injetado: true } })
    expect(decodeState(state)?.projectId).toBeNull()
  })
})

describe('decodeState — entrada hostil', () => {
  it.each([
    ['não é base64', 'não-é-base64-válido!!!'],
    ['base64 que não é JSON', Buffer.from('nada disso').toString('base64url')],
    ['JSON sem csrf', encode({ projectId: 'abc' })],
    ['csrf de tipo errado', encode({ csrf: 12345, projectId: null })],
    ['csrf curto demais', encode({ csrf: 'abc', projectId: null })],
    [
      'csrf fora do alfabeto hex',
      encode({ csrf: 'z'.repeat(64), projectId: null }),
    ],
    ['array em vez de objeto', encode([validCsrf])],
    ['null', encode(null)],
    ['string vazia', ''],
  ])('rejeita %s', (_label, input) => {
    expect(decodeState(input)).toBeNull()
  })

  it('rejeita csrf com tamanho quase certo', () => {
    expect(
      decodeState(encode({ csrf: 'a'.repeat(63), projectId: null })),
    ).toBeNull()
    expect(
      decodeState(encode({ csrf: 'a'.repeat(65), projectId: null })),
    ).toBeNull()
  })
})
