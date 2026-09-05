import crypto from 'node:crypto'

/**
 * Transporte do checkpoint SEM entregar credencial GitHub ao cliente.
 *
 * O daemon manda um CHANGESET content-addressed do commit do checkpoint: por
 * arquivo, a operação (add/modify/delete) e — quando add/modify — o conteúdo em
 * base64 (BINÁRIO-safe, não só texto) com o SHA-256 do conteúdo. O backend valida
 * integridade e tamanho, e APLICA via Git Data API (server-side), recriando o
 * commit na branch de integração. Nada de packfile no cliente, nada de token no
 * cliente.
 *
 * Propriedades: binário-safe (base64), diffs grandes razoáveis (com teto),
 * idempotente (checkpoint_id), integridade por SHA-256 (por arquivo + do
 * changeset inteiro), autenticado pelo device. Módulo PURO — o I/O (Git Data API)
 * vive em publish.ts.
 */

export type FileOpKind = 'add' | 'modify' | 'delete'

export interface FileOp {
  path: string
  op: FileOpKind
  /** base64 do conteúdo (só em add/modify; ausente em delete). Binário-safe. */
  contentBase64?: string
  /** SHA-256 (hex) do conteúdo decodificado (só em add/modify). Integridade. */
  sha256?: string
  /** 100644 (arquivo) ou 100755 (executável). Default 100644. */
  mode?: '100644' | '100755'
}

export interface Changeset {
  checkpointId: string
  /** SHA do commit local (registro/auditoria; o publicado é recriado). */
  commitSha: string
  parentCheckpointId: string | null
  message: string
  authorName: string
  authorEmail: string
  files: FileOp[]
}

/** Teto do changeset (base64 inflaciona ~33%; ver limite de body do runtime). */
export const MAX_CHANGESET_BYTES = 4 * 1024 * 1024 // 4 MiB de conteúdo decodificado

export function sha256Hex(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** Bytes de conteúdo decodificado somados (não conta a metadata). */
export function changesetContentBytes(cs: Changeset): number {
  let total = 0
  for (const f of cs.files) {
    if (f.contentBase64) total += Buffer.byteLength(f.contentBase64, 'base64')
  }
  return total
}

/** SHA-256 canônico do changeset inteiro (ordem estável dos arquivos por path). */
export function computeChangesetSha256(cs: Changeset): string {
  const files = [...cs.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const canonical = JSON.stringify({
    checkpointId: cs.checkpointId,
    parentCheckpointId: cs.parentCheckpointId,
    message: cs.message,
    files: files.map((f) => ({
      path: f.path,
      op: f.op,
      sha256: f.sha256 ?? null,
      mode: f.mode ?? '100644',
    })),
  })
  return sha256Hex(canonical)
}

export type ChangesetValidation =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'empty'
        | 'too_large'
        | 'changeset_hash_mismatch'
        | 'file_hash_mismatch'
        | 'bad_op'
    }

/**
 * Valida um changeset recebido: não-vazio, dentro do teto, e íntegro — o SHA-256
 * declarado do changeset bate, e cada arquivo add/modify tem conteúdo cujo
 * SHA-256 bate com o declarado. Um checkpoint adulterado/hash divergente é
 * REJEITADO (fail-closed). PURA.
 */
export function validateChangeset(input: {
  changeset: Changeset
  declaredSha256: string
  maxBytes?: number
}): ChangesetValidation {
  const { changeset, declaredSha256 } = input
  const maxBytes = input.maxBytes ?? MAX_CHANGESET_BYTES

  if (changeset.files.length === 0) return { ok: false, reason: 'empty' }
  if (changesetContentBytes(changeset) > maxBytes) return { ok: false, reason: 'too_large' }
  if (computeChangesetSha256(changeset) !== declaredSha256) {
    return { ok: false, reason: 'changeset_hash_mismatch' }
  }

  for (const f of changeset.files) {
    if (f.op === 'delete') {
      if (f.contentBase64 || f.sha256) return { ok: false, reason: 'bad_op' }
      continue
    }
    if (f.op !== 'add' && f.op !== 'modify') return { ok: false, reason: 'bad_op' }
    if (f.contentBase64 === undefined || !f.sha256) return { ok: false, reason: 'bad_op' }
    const decoded = Buffer.from(f.contentBase64, 'base64')
    if (sha256Hex(decoded) !== f.sha256) return { ok: false, reason: 'file_hash_mismatch' }
  }
  return { ok: true }
}

// ── Alvo de publicação: a main é IMPOSSÍVEL pelo endpoint ────────────────────

export const PROTECTED_BRANCHES = new Set(['main', 'master'])

/**
 * Garante que o alvo do publish é uma branch de INTEGRAÇÃO — nunca a main, a
 * default branch, nem outra protegida. O backend DERIVA a branch; esta função é
 * a trava final (defesa em profundidade). Lança se o alvo for proibido.
 */
export function assertPublishableTarget(
  branch: string,
  opts: { defaultBranch: string; protectedBranches?: readonly string[] } = {
    defaultBranch: 'main',
  },
): void {
  const b = branch.trim()
  if (!b) throw new Error('Alvo de publish vazio.')
  if (PROTECTED_BRANCHES.has(b)) throw new Error(`Alvo proibido: "${b}".`)
  if (b === opts.defaultBranch) throw new Error(`Alvo é a default branch: "${b}".`)
  for (const p of opts.protectedBranches ?? []) {
    if (b === p) throw new Error(`Alvo protegido: "${b}".`)
  }
  // Uma branch de integração do Supremo é sempre prefixada — nada fora disso.
  if (!b.startsWith('supremo/')) throw new Error(`Alvo fora do namespace de integração: "${b}".`)
}
