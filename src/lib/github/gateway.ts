import {
  allowAutoMerge,
  enableNativeAutoMerge,
  getChecks,
  getPullRequest,
  mergePullRequest,
} from '@/lib/mcp/github'
import type { GithubCredentials } from '@/lib/mcp/repository'
import type { MergeGateway } from './merge-controller'

/**
 * Liga o `MergeGateway` (consumido por reconcileMerge) às operações REAIS do
 * GitHub em `mcp/github.ts`, usando credenciais da GitHub App (server-side). É só
 * fiação de I/O — toda a decisão vive nos módulos puros já testados.
 */
export function githubMergeGateway(creds: GithubCredentials): MergeGateway {
  return {
    getPullRequest: async (prNumber) => {
      const pr = await getPullRequest(creds, prNumber)
      return {
        headSha: pr.headSha,
        nodeId: pr.nodeId,
        merged: pr.merged,
        state: pr.state,
      }
    },
    getChecks: async (ref) => {
      const r = await getChecks(creds, ref)
      return { checks: r.checks, headSha: r.headSha }
    },
    allowAutoMerge: () => allowAutoMerge(creds),
    enableNativeAutoMerge: (nodeId) => enableNativeAutoMerge(creds, nodeId),
    merge: (prNumber, expectedSha) =>
      mergePullRequest(creds, prNumber, undefined, expectedSha),
  }
}
