import {
  allowAutoMerge,
  deleteBranch,
  disableNativeAutoMerge,
  enableNativeAutoMerge,
  getChecks,
  getPullRequest,
  mergePullRequest,
  octokitFor,
} from '@/lib/github/client'
import type { GithubCredentials } from '@/lib/projects/repository'
import type { MergeGateway } from './merge-controller'

/**
 * Liga o `MergeGateway` (consumido por reconcileMerge) às operações REAIS do
 * GitHub em `github/client.ts`, usando credenciais da GitHub App (server-side). É só
 * fiação de I/O — toda a decisão vive nos módulos puros já testados.
 */
export function githubMergeGateway(creds: GithubCredentials): MergeGateway {
  return {
    getPullRequest: async (prNumber) => {
      const pr = await getPullRequest(creds, prNumber)
      return {
        headSha: pr.headSha,
        headRef: pr.headRef,
        nodeId: pr.nodeId,
        merged: pr.merged,
        state: pr.state,
        autoMergeEnabled: pr.autoMergeEnabled ?? false,
      }
    },
    getChecks: async (ref) => {
      const r = await getChecks(creds, ref)
      return { checks: r.checks, headSha: r.headSha }
    },
    hasRequiredChecks: async (required) => {
      try {
        const { data } = await octokitFor(creds).repos.getBranchProtection({
          owner: creds.owner, repo: creds.repo, branch: creds.defaultBranch,
        })
        const configured = new Set([
          ...(data.required_status_checks?.contexts ?? []),
          ...(data.required_status_checks?.checks ?? []).map((check) => check.context),
        ])
        return required.length > 0 && required.every((name) => configured.has(name))
      } catch { return false }
    },
    disableNativeAutoMerge: (nodeId) => disableNativeAutoMerge(creds, nodeId),
    allowAutoMerge: () => allowAutoMerge(creds),
    enableNativeAutoMerge: (nodeId) => enableNativeAutoMerge(creds, nodeId),
    merge: (prNumber, expectedSha) =>
      mergePullRequest(creds, prNumber, undefined, expectedSha),
    deleteBranch: (branch) => deleteBranch(creds, branch),
  }
}
