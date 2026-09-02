import { octokitFor } from '@/lib/mcp/github'
import type { GithubCredentials } from '@/lib/mcp/repository'
import { assertPublishableTarget, type FileOp } from './changeset'

/**
 * Aplicação do changeset EXCLUSIVAMENTE server-side, via Git Data API (Octokit) —
 * sem git binário e sem packfile, funciona em runtime serverless e é binário-safe
 * (blobs base64). O token da App é usado SÓ aqui, no servidor, e nunca sai.
 *
 * Recria o commit do checkpoint sobre `baseSha` (tip real da branch de integração
 * ou da main), atualiza a ref por fast-forward — NUNCA force, NUNCA a main (trava
 * dupla: o alvo já foi derivado server-side e é re-checado aqui). Adapter de I/O.
 */

export interface ApplyChangesetInput {
  branch: string
  baseSha: string
  defaultBranch: string
  files: readonly FileOp[]
  message: string
  authorName: string
  authorEmail: string
}

export async function applyChangeset(
  creds: GithubCredentials,
  input: ApplyChangesetInput,
): Promise<{ commitSha: string; created: boolean }> {
  // Trava final: jamais a main/default/protegida (defesa em profundidade).
  assertPublishableTarget(input.branch, { defaultBranch: input.defaultBranch })

  const gh = octokitFor(creds)
  const { owner, repo } = creds

  // Árvore base = a do commit de base (tip da integração ou main).
  const baseCommit = await gh.git.getCommit({ owner, repo, commit_sha: input.baseSha })
  const baseTreeSha = baseCommit.data.tree.sha

  // Blobs (base64 → binário-safe) para add/modify; delete vira sha:null na árvore.
  const treeEntries: Array<{
    path: string
    mode: '100644' | '100755'
    type: 'blob'
    sha: string | null
  }> = []
  for (const f of input.files) {
    if (f.op === 'delete') {
      treeEntries.push({ path: f.path, mode: f.mode ?? '100644', type: 'blob', sha: null })
      continue
    }
    const blob = await gh.git.createBlob({
      owner,
      repo,
      content: f.contentBase64!,
      encoding: 'base64',
    })
    treeEntries.push({
      path: f.path,
      mode: f.mode ?? '100644',
      type: 'blob',
      sha: blob.data.sha,
    })
  }

  const tree = await gh.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    // sha:null remove o path (semântica da Git Data API para deleção).
    tree: treeEntries,
  })

  const commit = await gh.git.createCommit({
    owner,
    repo,
    message: input.message,
    tree: tree.data.sha,
    parents: [input.baseSha],
    author: {
      name: input.authorName,
      email: input.authorEmail,
      date: new Date().toISOString(),
    },
  })
  const commitSha = commit.data.sha

  // Atualiza a ref por fast-forward; cria se não existir. NUNCA force.
  const ref = `heads/${input.branch}`
  try {
    await gh.git.updateRef({ owner, repo, ref, sha: commitSha, force: false })
    return { commitSha, created: false }
  } catch {
    await gh.git.createRef({ owner, repo, ref: `refs/${ref}`, sha: commitSha })
    return { commitSha, created: true }
  }
}
