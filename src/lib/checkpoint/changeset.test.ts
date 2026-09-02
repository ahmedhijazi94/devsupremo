import { describe, expect, it } from 'vitest'
import {
  assertPublishableTarget,
  changesetContentBytes,
  computeChangesetSha256,
  sha256Hex,
  validateChangeset,
  type Changeset,
} from './changeset'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

/** Changeset válido (hashes reais dos conteúdos). */
function validCs(over: Partial<Changeset> = {}): Changeset {
  const content = 'olá mundo'
  return {
    checkpointId: '11111111-1111-1111-1111-111111111111',
    commitSha: 'abcdef1234567',
    parentCheckpointId: null,
    message: 'checkpoint: x',
    authorName: 'Dev',
    authorEmail: 'd@e.co',
    files: [
      {
        path: 'app/page.tsx',
        op: 'modify',
        contentBase64: b64(content),
        sha256: sha256Hex(Buffer.from(content, 'utf8')),
        mode: '100644',
      },
      { path: 'old.ts', op: 'delete' },
    ],
    ...over,
  }
}

describe('computeChangesetSha256', () => {
  it('é determinístico e independe da ordem dos arquivos', () => {
    const a = validCs()
    const b = { ...a, files: [a.files[1]!, a.files[0]!] }
    expect(computeChangesetSha256(a)).toBe(computeChangesetSha256(b))
  })
  it('golden — paridade com o CLI (não pode mudar sem atualizar ambos)', () => {
    const cs: Changeset = {
      checkpointId: '11111111-1111-1111-1111-111111111111',
      commitSha: 'abcdef1234567',
      parentCheckpointId: null,
      message: 'checkpoint: x',
      authorName: 'Dev',
      authorEmail: 'd@e.co',
      files: [
        { path: 'b.ts', op: 'add', contentBase64: b64('b'), sha256: 'x'.repeat(64), mode: '100644' },
        { path: 'a.ts', op: 'delete' },
      ],
    }
    expect(computeChangesetSha256(cs)).toBe(
      'f7b689b91396a36d617e8bb634f876a3d861cc25f9a88e7615deafe482adcb6e',
    )
  })
})

describe('validateChangeset — integridade e tamanho (testes 7, 8)', () => {
  it('changeset válido passa', () => {
    const cs = validCs()
    expect(validateChangeset({ changeset: cs, declaredSha256: computeChangesetSha256(cs) })).toEqual({
      ok: true,
    })
  })
  it('vazio → rejeita', () => {
    const cs = validCs({ files: [] })
    expect(validateChangeset({ changeset: cs, declaredSha256: computeChangesetSha256(cs) })).toEqual(
      { ok: false, reason: 'empty' },
    )
  })
  it('acima do teto → rejeita (teste 8)', () => {
    const cs = validCs()
    const r = validateChangeset({
      changeset: cs,
      declaredSha256: computeChangesetSha256(cs),
      maxBytes: 1,
    })
    expect(r).toEqual({ ok: false, reason: 'too_large' })
  })
  it('SHA do changeset divergente → rejeita (teste 7)', () => {
    const cs = validCs()
    expect(validateChangeset({ changeset: cs, declaredSha256: 'deadbeef' })).toEqual({
      ok: false,
      reason: 'changeset_hash_mismatch',
    })
  })
  it('conteúdo adulterado (hash de arquivo divergente) → rejeita (teste 7)', () => {
    const cs = validCs()
    cs.files[0]!.contentBase64 = b64('CONTEÚDO ADULTERADO')
    // recomputa o sha do changeset para passar da 1ª trava e cair na do arquivo
    expect(validateChangeset({ changeset: cs, declaredSha256: computeChangesetSha256(cs) })).toEqual(
      { ok: false, reason: 'file_hash_mismatch' },
    )
  })
  it('delete com conteúdo → bad_op', () => {
    const cs = validCs()
    cs.files[1] = { path: 'old.ts', op: 'delete', contentBase64: b64('x'), sha256: 'y' }
    expect(validateChangeset({ changeset: cs, declaredSha256: computeChangesetSha256(cs) })).toEqual(
      { ok: false, reason: 'bad_op' },
    )
  })

  it('changesetContentBytes soma só conteúdo decodificado', () => {
    expect(changesetContentBytes(validCs())).toBe(Buffer.byteLength('olá mundo', 'utf8'))
  })
})

describe('assertPublishableTarget — a main é IMPOSSÍVEL (testes 3, 4, 11)', () => {
  it('rejeita main/master', () => {
    expect(() => assertPublishableTarget('main', { defaultBranch: 'main' })).toThrow()
    expect(() => assertPublishableTarget('master', { defaultBranch: 'main' })).toThrow()
  })
  it('rejeita a default branch mesmo que não seja "main"', () => {
    expect(() => assertPublishableTarget('trunk', { defaultBranch: 'trunk' })).toThrow()
  })
  it('rejeita branch protegida arbitrária', () => {
    expect(() =>
      assertPublishableTarget('release', { defaultBranch: 'main', protectedBranches: ['release'] }),
    ).toThrow()
  })
  it('rejeita alvo fora do namespace de integração supremo/', () => {
    expect(() => assertPublishableTarget('feature/x', { defaultBranch: 'main' })).toThrow()
  })
  it('aceita a branch de integração derivada server-side', () => {
    expect(() =>
      assertPublishableTarget('supremo/cp-abc123', { defaultBranch: 'main' }),
    ).not.toThrow()
  })
})
