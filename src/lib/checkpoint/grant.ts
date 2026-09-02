import type { CheckpointDeviceRow } from './devices'

/**
 * Decisão PURA do "push grant": dado um device autenticado, o projeto pedido e o
 * conjunto de arquivos do checkpoint, decide se o backend pode emitir um
 * installation token e com QUAIS permissões mínimas.
 *
 * Princípios (não negociáveis):
 *   • o token é escopado ao repository_id EXATO do projeto (feito no adapter);
 *   • permissão mínima: contents:write; só há workflows:write se o diff mexe em
 *     .github/workflows/**;
 *   • grant do projeto A jamais serve para o repo de B (o projeto pedido tem de
 *     ser do dono do device E o repo/owner do token vêm do próprio projeto);
 *   • fail-closed: qualquer dúvida → recusa.
 *
 * O token do daemon NUNCA carrega permissão de merge/PR/checks/admin — isso é do
 * Control Plane. Aqui só sai o suficiente para ENVIAR o checkpoint à branch.
 */

/** Permissões possíveis do token entregue ao daemon (mínimas, por design). */
export interface PushTokenPermissions {
  contents: 'write'
  workflows?: 'write'
}

/** Detecta se o diff toca em qualquer workflow do GitHub Actions. */
export function diffTouchesWorkflows(changedPaths: readonly string[]): boolean {
  return changedPaths.some((p) => {
    const norm = p.replace(/^\.\//, '').replace(/^\/+/, '')
    return norm.startsWith('.github/workflows/')
  })
}

/**
 * Permissões mínimas para o checkpoint: contents:write no caso normal; adiciona
 * workflows:write SOMENTE quando o diff inclui `.github/workflows/**` (o GitHub
 * recusa push a workflows sem essa permissão).
 */
export function decideTokenPermissions(
  changedPaths: readonly string[],
): PushTokenPermissions {
  return diffTouchesWorkflows(changedPaths)
    ? { contents: 'write', workflows: 'write' }
    : { contents: 'write' }
}

/** Projeto, do ponto de vista da autorização (só o necessário — não é I/O). */
export interface GrantProject {
  id: string
  userId: string
  repoFullName: string | null
  ownerLogin: string | null
  ownerType: 'personal' | 'organization' | null
  defaultBranch: string
}

export type PushGrantDecision =
  | {
      ok: true
      repoFullName: string
      ownerLogin: string
      ownerType: 'personal' | 'organization'
      permissions: PushTokenPermissions
    }
  | {
      ok: false
      reason:
        | 'device_owner_mismatch'
        | 'project_mismatch'
        | 'repo_not_provisioned'
        | 'owner_not_resolved'
    }

/**
 * Autoriza (ou recusa) a emissão do token de push. PURA e fail-closed.
 *
 * Recusa se:
 *   • o device não é do dono do projeto (device_owner_mismatch);
 *   • o projectId pedido não bate com o projeto carregado (project_mismatch) —
 *     impede reutilizar um grant de A apontando para B;
 *   • o projeto não tem repo provisionado (repo_not_provisioned);
 *   • não dá para resolver o owner/instalação do repo (owner_not_resolved).
 *
 * O `ownerLogin` sai do PRÓPRIO projeto — o adapter usa esse login para achar a
 * installation e o repository_id, garantindo que o token nasce preso ao repo do
 * projeto (e a nenhum outro).
 */
export function authorizePushGrant(input: {
  device: Pick<CheckpointDeviceRow, 'ownerUserId'>
  project: GrantProject
  requestedProjectId: string
  changedPaths: readonly string[]
}): PushGrantDecision {
  const { device, project, requestedProjectId, changedPaths } = input

  if (project.id !== requestedProjectId) {
    return { ok: false, reason: 'project_mismatch' }
  }
  if (project.userId !== device.ownerUserId) {
    return { ok: false, reason: 'device_owner_mismatch' }
  }
  if (!project.repoFullName) {
    return { ok: false, reason: 'repo_not_provisioned' }
  }
  // Owner pessoal antigo pode vir NULL: nesse caso o owner é o próprio dono, e o
  // login sai do repoFullName. Só recusamos se nem isso der.
  const ownerFromRepo = project.repoFullName.split('/')[0] ?? ''
  const ownerLogin = project.ownerLogin ?? ownerFromRepo
  if (!ownerLogin) {
    return { ok: false, reason: 'owner_not_resolved' }
  }
  const ownerType: 'personal' | 'organization' =
    project.ownerType ?? 'personal'

  return {
    ok: true,
    repoFullName: project.repoFullName,
    ownerLogin,
    ownerType,
    permissions: decideTokenPermissions(changedPaths),
  }
}
