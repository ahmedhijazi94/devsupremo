/**
 * Integração assíncrona dos checkpoints — decisão PURA de branch/race (seção 6).
 *
 * Cenário crítico (sem intervenção humana):
 *   Prompt A → checkpoint A → push → PR A → CI
 *   Prompt B → checkpoint B  (enquanto A ainda roda)
 *   ...e A pode ser AUTO-MERGEADO na main nesse meio-tempo.
 *
 * Invariantes que esta lógica garante:
 *   • nunca push direto na main; nunca force-push na main;
 *   • nunca perder B;
 *   • nunca reintroduzir mudanças já integradas (delta apenas);
 *   • antes de integrar, reavalia o estado REAL (main/PR/branch);
 *   • preserva a proteção HEAD/SHA da v3 (expectedBaseSha).
 *
 * Aqui só decidimos O QUE fazer; o daemon executa (cherry-pick do delta numa
 * branch efêmera SEM tocar o worktree do usuário, e push com token escopado).
 */

export const INTEGRATION_BRANCH_PREFIX = 'supremo/cp-'
export const MAIN_BRANCHES = new Set(['main', 'master'])

/** Nome determinístico da branch de integração rotacionada (curto e único). */
export function rotatedBranchName(headSha: string): string {
  return `${INTEGRATION_BRANCH_PREFIX}${headSha.slice(0, 12)}`
}

/** Rejeita QUALQUER tentativa de usar a branch protegida como alvo de push. */
export function assertNotMain(branch: string): void {
  if (MAIN_BRANCHES.has(branch)) {
    throw new Error(`Recusado: push na branch protegida "${branch}" é proibido.`)
  }
}

export interface RemotePr {
  number: number
  headRef: string
  headSha: string
  merged: boolean
  state: string // 'open' | 'closed'
}

export interface RemoteState {
  /** HEAD real da main remota (base + anti-TOCTOU). */
  mainSha: string
  /** PR de integração corrente conhecida, relida do GitHub (ou null). */
  openPr: RemotePr | null
  /** Branch que o último push usou (estado persistido), ou null. */
  integrationBranch: string | null
}

export interface LocalState {
  /** HEAD local — o commit do checkpoint mais recente. */
  headSha: string
  /** Último commit que sabemos estar integrado (na main) ou já empurrado. */
  lastIntegratedSha: string | null
}

export type IntegrationPlan =
  | {
      action: 'reuse'
      branch: string
      /** Empurra o HEAD local para a MESMA branch da PR aberta (fast-forward). */
      pushSha: string
      base: string
      expectedBaseSha: string
    }
  | {
      action: 'rotate'
      branch: string
      /** Range a cherry-pickar numa branch efêmera nova sobre a main atual. */
      deltaRange: { fromSha: string | null; toSha: string }
      base: string
      expectedBaseSha: string
    }

/**
 * Decide como integrar o checkpoint atual, relido o estado real.
 *
 * REUSE — há PR aberta, não mergeada, cujo head é a nossa branch de integração:
 *   o HEAD local está por cima dela; empurramos por fast-forward. A PR passa a
 *   conter A+B; o auto-merge integra os dois — B não se perde.
 *
 * ROTATE — não há PR aberta reutilizável (nenhuma, fechada, mergeada, ou a
 *   branch divergiu). A PR anterior já pode ter ido para a main; criamos uma
 *   branch NOVA sobre a main atual e integramos SÓ o delta ainda não integrado
 *   (lastIntegratedSha..HEAD). Assim não reintroduzimos o que já entrou.
 *
 * `base` é sempre a main (o merge é para a main), mas o push é SEMPRE para uma
 * branch de trabalho — nunca a main.
 */
export function planIntegration(input: {
  remote: RemoteState
  local: LocalState
}): IntegrationPlan {
  const { remote, local } = input
  const base = 'main'

  const reusable =
    remote.openPr !== null &&
    remote.openPr.state === 'open' &&
    !remote.openPr.merged &&
    remote.integrationBranch !== null &&
    remote.openPr.headRef === remote.integrationBranch

  if (reusable) {
    const branch = remote.integrationBranch as string
    assertNotMain(branch)
    return {
      action: 'reuse',
      branch,
      pushSha: local.headSha,
      base,
      expectedBaseSha: remote.mainSha,
    }
  }

  const branch = rotatedBranchName(local.headSha)
  assertNotMain(branch)
  return {
    action: 'rotate',
    branch,
    deltaRange: { fromSha: local.lastIntegratedSha, toSha: local.headSha },
    base,
    expectedBaseSha: remote.mainSha,
  }
}

/**
 * Guarda anti-TOCTOU: no instante do push, a main observada precisa ser a mesma
 * do plano (expectedBaseSha). Se a main avançou (ex.: A mergeou depois do
 * planejamento), o plano está velho — o daemon re-planeja em vez de integrar um
 * HEAD desatualizado. HEAD antigo NUNCA integra.
 */
export function baseIsFresh(
  observedMainSha: string,
  expectedBaseSha: string,
): boolean {
  return observedMainSha === expectedBaseSha
}

/**
 * Proteção CROSS-MACHINE (v3.3 — sincronização entre máquinas), fora do
 * alcance de `baseIsFresh` acima: aquela guarda cobre a MESMA máquina
 * reavaliando seu próprio plano no instante do push. Esta cobre DUAS
 * máquinas publicando a partir do MESMO checkpoint conhecido, sem saber uma
 * da outra — `applyChangeset` recria a árvore só com os arquivos que o
 * changeset tocou, por cima do tip atual; se outro checkpoint (que este
 * changeset nunca viu) já avançou o projeto, aplicar cegamente por cima
 * pode descartar em silêncio o que ele mudou nos mesmos arquivos.
 *
 * `parent_checkpoint_id` (já existente — a base sobre a qual o checkpoint foi
 * criado, "base_sha ou equivalente" reaproveitado, não uma coluna nova) é
 * comparado contra o checkpoint mais recente REALMENTE conhecido do projeto
 * (excluindo este próprio — reenvio idempotente não é divergência). Só
 * `true` quando batem: nenhuma outra máquina publicou algo nesse meio-tempo.
 *
 * Ex.: máquina A publica D com base C; máquina B tenta publicar E também com
 * base C. No instante do publish de E, o mais recente conhecido já é D — a
 * base declarada (C) não bate mais → recusa. D fica intacto, E não é
 * publicado por cima dele (nunca se perde — o commit LOCAL de E continua
 * intacto na máquina B; só o publish é recusado até sincronizar).
 */
export function baseCheckpointIsFresh(input: {
  declaredBaseCheckpointId: string | null
  latestKnownCheckpointId: string | null
}): boolean {
  return input.declaredBaseCheckpointId === input.latestKnownCheckpointId
}
