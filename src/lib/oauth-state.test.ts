import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  decodeState,
  createOAuthState,
  consumeOAuthState,
} from './oauth-state'

const validCsrf = 'a'.repeat(64)

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

/**
 * Client Supabase fake: cada método do query builder encadeia (retorna o
 * próprio builder), e insert/maybeSingle resolvem o resultado configurado.
 */
function fakeClient(result: unknown, onInsert?: (row: unknown) => void) {
  const qb: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'maybeSingle') return async () => result
        if (prop === 'insert')
          return async (row: unknown) => {
            onInsert?.(row)
            return result
          }
        return () => qb
      },
    },
  )
  return { from: () => qb } as unknown as SupabaseClient
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

describe('createOAuthState', () => {
  it('persiste o state e devolve um payload decodificável', async () => {
    let inserted: Record<string, unknown> | undefined
    const client = fakeClient({ error: null }, (row) => {
      inserted = row as Record<string, unknown>
    })
    const state = await createOAuthState(client, 'user-1', 'github', 'proj-1')

    const decoded = decodeState(state)
    expect(decoded?.projectId).toBe('proj-1')
    expect(decoded?.csrf).toMatch(/^[0-9a-f]{64}$/)
    // grava o mesmo csrf, com escopo e uso único (consumed_at null, expira)
    expect(inserted).toMatchObject({
      user_id: 'user-1',
      provider: 'github',
      project_id: 'proj-1',
      consumed_at: null,
    })
    expect(inserted!.state).toBe(decoded!.csrf)
  })

  it('falha de escrita vira erro claro', async () => {
    const client = fakeClient({ error: { message: 'boom' } })
    await expect(
      createOAuthState(client, 'u', 'supabase'),
    ).rejects.toThrow(/state de OAuth/)
  })
})

describe('consumeOAuthState (uso único)', () => {
  it('state válido: consome e devolve o projectId', async () => {
    const raw = encode({ csrf: validCsrf, projectId: 'proj-9' })
    const client = fakeClient({ data: { project_id: 'proj-9' }, error: null })
    const res = await consumeOAuthState(client, 'u', 'github', raw)
    expect(res).toEqual({ projectId: 'proj-9' })
  })

  it('já consumido/expirado (update não casa): devolve null', async () => {
    const raw = encode({ csrf: validCsrf, projectId: null })
    const client = fakeClient({ data: null, error: null })
    expect(await consumeOAuthState(client, 'u', 'github', raw)).toBeNull()
  })

  it('state malformado nem toca o banco', async () => {
    const from = vi.fn()
    const client = { from } as unknown as SupabaseClient
    expect(await consumeOAuthState(client, 'u', 'github', 'lixo!!')).toBeNull()
    expect(from).not.toHaveBeenCalled()
  })
})
