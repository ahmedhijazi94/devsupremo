import {
  allowAutoMerge,
  deleteBranch,
  disableNativeAutoMerge,
  enableNativeAutoMerge,
  readFile,
  getPullRequest,
  mergePullRequest,
  octokitFor,
} from '@/lib/github/client'
import type { GithubCredentials } from '@/lib/projects/repository'
import type { MergeGateway } from './merge-controller'
import { getProject, getProjectByRepoFullName } from '@/lib/projects/repository'
import { selectTrustedWorkflow, verifyCandidatePolicy, workflowChecks } from './trusted-policy'

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
      const gh = octokitFor(creds)
      const { data } = await gh.actions.listWorkflowRuns({
        owner: creds.owner, repo: creds.repo, workflow_id: 'ci.yml', head_sha: ref, per_page: 100,
      })
      const run = selectTrustedWorkflow(data.workflow_runs, ref)
      if (!run) return { checks: [], headSha: ref }
      const jobs = await gh.paginate(gh.actions.listJobsForWorkflowRun, {
        owner: creds.owner, repo: creds.repo, run_id: run.id, filter: 'latest', per_page: 100,
      })
      return { checks: workflowChecks(run, jobs), headSha: run.head_sha }
    },
    verifyPolicy: async (headSha) => {
      const workerProject = await getProjectByRepoFullName(creds.repoFullName)
      if (!workerProject) return { approved: false, headSha, reasons: ['Repositório sem projeto autorizado.'] }
      const project = await getProject(workerProject.userId, workerProject.id)
      const gh = octokitFor(creds)
      const [treeResult, packageContent, lockContent] = await Promise.all([
        gh.git.getTree({ owner: creds.owner, repo: creds.repo, tree_sha: headSha, recursive: 'true' }),
        readFile(creds, 'package.json', headSha), readFile(creds, 'package-lock.json', headSha),
      ])
      return verifyCandidatePolicy({
        headSha, kind: project.kind, truncated: treeResult.data.truncated,
        tree: treeResult.data.tree.filter(entry => entry.type !== 'tree').map(entry => ({
          path: entry.path ?? '', sha: entry.sha ?? '', mode: entry.mode ?? '',
        })), packageContent, lockContent,
      })
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
