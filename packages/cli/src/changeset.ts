import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import type { CheckpointRecord } from './checkpoint'

/**
 * Changeset content-addressed do commit do checkpoint — o QUE o daemon envia ao
 * Supremo em vez de dar push. Binário-safe (base64), com SHA-256 por arquivo e do
 * changeset inteiro (integridade). Requer só leitura do git LOCAL — NENHUMA
 * credencial GitHub. O hashing canônico é IDÊNTICO ao do backend (validação).
 */

export type FileOpKind = 'add' | 'modify' | 'delete'

export interface FileOp {
  path: string
  op: FileOpKind
  contentBase64?: string
  sha256?: string
  mode?: '100644' | '100755'
}

export interface Changeset {
  checkpointId: string
  commitSha: string
  parentCheckpointId: string | null
  message: string
  authorName: string
  authorEmail: string
  files: FileOp[]
}

export function sha256Hex(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** DEVE bater byte-a-byte com o backend (src/lib/checkpoint/changeset.ts). */
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

// ── Leitor do commit (injetável; sem rede, sem credencial) ───────────────────

export interface CommitChange {
  status: string // A|M|D|R...|T|C
  path: string
  oldPath?: string
}

export interface CommitReader {
  /** Mudanças do commit (sha^..sha). */
  changes(sha: string, baseSha?: string): CommitChange[]
  /** Conteúdo do arquivo NESSE commit (Buffer bruto; binário-safe). null se ausente. */
  content(sha: string, path: string): Buffer | null
  /** Metadata do commit. */
  meta(sha: string): { message: string; authorName: string; authorEmail: string }
  /** true se o arquivo é executável (mode 100755) nesse commit. */
  executable(sha: string, path: string): boolean
}

/** Monta o changeset de um checkpoint a partir do leitor. PURO (I/O injetado). */
export function buildChangeset(
  record: CheckpointRecord,
  reader: CommitReader,
): Changeset {
  const sha = record.commitSha
  const meta = reader.meta(sha)
  const files: FileOp[] = []

  for (const ch of reader.changes(sha, record.changesetBaseSha)) {
    const st = ch.status[0] ?? ''
    if (st === 'D') {
      files.push({ path: ch.path, op: 'delete' })
      continue
    }
    if (st === 'R' && ch.oldPath && ch.oldPath !== ch.path) {
      // Rename = delete do antigo + add do novo (aplicável via Git Data API).
      files.push({ path: ch.oldPath, op: 'delete' })
    }
    const buf = reader.content(sha, ch.path)
    if (buf === null) {
      // Sem conteúdo (deve ser deleção): registra como delete e segue.
      files.push({ path: ch.path, op: 'delete' })
      continue
    }
    files.push({
      path: ch.path,
      op: st === 'A' || st === 'R' || st === 'C' ? 'add' : 'modify',
      contentBase64: buf.toString('base64'),
      sha256: sha256Hex(buf),
      mode: reader.executable(sha, ch.path) ? '100755' : '100644',
    })
  }

  return {
    checkpointId: record.checkpointId,
    commitSha: sha,
    parentCheckpointId: record.parentCheckpointId,
    message: meta.message,
    authorName: meta.authorName,
    authorEmail: meta.authorEmail,
    files,
  }
}

// ── Leitor real (git local, só leitura) ──────────────────────────────────────

export function defaultCommitReader(cwd: string): CommitReader {
  const text = (args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const hasParent = (sha: string): boolean => {
    try {
      execFileSync('git', ['rev-parse', '--verify', `${sha}^`], {
        cwd,
        stdio: 'ignore',
      })
      return true
    } catch {
      return false
    }
  }
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904' // git empty tree
  return {
    changes: (sha, baseSha) => {
      const base = baseSha ?? (hasParent(sha) ? `${sha}^` : EMPTY_TREE)
      const out = text(['diff', '--name-status', '-z', base, sha])
      // Formato -z: registros separados por NUL; rename ocupa 3 campos.
      const parts = out.split('\0').filter((p) => p.length > 0)
      const changes: CommitChange[] = []
      for (let i = 0; i < parts.length; ) {
        const status = parts[i++] ?? ''
        if (status.startsWith('R') || status.startsWith('C')) {
          const oldPath = parts[i++] ?? ''
          const path = parts[i++] ?? ''
          changes.push({ status, path, oldPath })
        } else {
          const path = parts[i++] ?? ''
          changes.push({ status, path })
        }
      }
      return changes
    },
    content: (sha, path) => {
      try {
        return execFileSync('git', ['show', `${sha}:${path}`], {
          cwd,
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 64 * 1024 * 1024,
        })
      } catch {
        return null
      }
    },
    meta: (sha) => {
      const message = text(['show', '-s', '--format=%B', sha]).replace(/\n+$/, '\n').trimEnd()
      const authorName = text(['show', '-s', '--format=%an', sha]).trim()
      const authorEmail = text(['show', '-s', '--format=%ae', sha]).trim()
      return { message: message || 'checkpoint', authorName, authorEmail }
    },
    executable: (sha, path) => {
      try {
        const line = text(['ls-tree', sha, path])
        return line.slice(0, 6) === '100755'
      } catch {
        return false
      }
    },
  }
}
