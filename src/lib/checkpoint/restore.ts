/**
 * Restore no próprio Supremo (v3.1 finalização) — decisão PURA de autorização e
 * de mapeamento de status humano. O restore NUNCA reescreve histórico: clicar
 * "Restaurar B" cria um pedido que o daemon da máquina original consome e fecha
 * com um checkpoint NOVO (E) cujo código fica igual ao de B — A→B→C→D→E, nunca
 * um reset. O I/O (poll/claim/relatar) vive em adapters; aqui só a decisão.
 */

export interface RestoreCheckpointRow {
  id: string
  projectId: string
}

export type RestoreAuthDecision =
  | { ok: true }
  | { ok: false; reason: 'checkpoint_not_found' | 'project_mismatch' }

/**
 * Autoriza um pedido de restore: o checkpoint-alvo precisa EXISTIR e pertencer
 * ao MESMO projeto pedido (nunca restaura um checkpoint de outro projeto/dono —
 * a autenticação do dono em si já é responsabilidade do chamador via RLS/sessão).
 */
export function authorizeRestoreRequest(input: {
  projectId: string
  target: RestoreCheckpointRow | null
}): RestoreAuthDecision {
  if (!input.target) return { ok: false, reason: 'checkpoint_not_found' }
  if (input.target.projectId !== input.projectId) {
    return { ok: false, reason: 'project_mismatch' }
  }
  return { ok: true }
}

export type RestoreReportAuthDecision =
  | { ok: true }
  | { ok: false; reason: 'restore_request_not_found' | 'device_owner_mismatch' }

/**
 * Autoriza `/api/checkpoint/restore-report`: o device autenticado só pode
 * fechar (applied/failed) um pedido de restore que pertence a um PROJETO DO
 * PRÓPRIO DONO do device — nunca o de outro usuário. `mcpDataClient()` (a
 * rota) usa service_role (ignora RLS), então esta checagem é a ÚNICA barreira
 * de dono aqui; sem ela, qualquer device autenticado (de qualquer projeto)
 * conseguiria reportar applied/failed num restoreRequestId arbitrário — um
 * IDOR clássico (objeto acessado por id sem checar dono). Fail-closed: pedido
 * inexistente OU de outro dono → mesma recusa (404), nunca revela qual caso é.
 */
export function authorizeRestoreReport(input: {
  device: { ownerUserId: string }
  restoreRequest: { projectOwnerUserId: string } | null
}): RestoreReportAuthDecision {
  if (!input.restoreRequest) return { ok: false, reason: 'restore_request_not_found' }
  if (input.restoreRequest.projectOwnerUserId !== input.device.ownerUserId) {
    return { ok: false, reason: 'device_owner_mismatch' }
  }
  return { ok: true }
}

// ── Status humano (a UI nunca mostra jargão de Git) ─────────────────────────

export type PushStatusRow = 'publishing' | 'published' | 'integrated' | 'failed'
export type IntegrationStatusRow =
  | 'ci_running'
  | 'merge_pending'
  | 'validated'
  | 'merged'
  | 'security_blocked'
  | null
  | undefined

export type HumanCheckpointStatus = 'Salvando' | 'Publicando' | 'Testando' | 'Integrado' | 'Falhou'

/**
 * Mapeia o estado técnico (push_status + integration_status) para o rótulo
 * humano do Histórico. Detalhes técnicos (SHA, PR, branch) ficam só na tela de
 * detalhe — o card principal nunca expõe jargão de Git.
 */
export function humanCheckpointStatus(
  pushStatus: PushStatusRow,
  integrationStatus: IntegrationStatusRow,
): HumanCheckpointStatus {
  if (pushStatus === 'failed') return 'Falhou'
  if (pushStatus === 'publishing') return 'Salvando'
  if (integrationStatus === 'security_blocked') return 'Falhou'
  if (integrationStatus === 'merged' || pushStatus === 'integrated') return 'Integrado'
  if (integrationStatus === 'ci_running' || integrationStatus === 'merge_pending') {
    return 'Testando'
  }
  // 'published' sem integration_status ainda conhecido: PR acabou de ser criada.
  return 'Publicando'
}

export type HumanRestoreStatus = 'Restaurando' | 'Restaurado' | 'Falhou'

export function humanRestoreStatus(status: 'pending' | 'claimed' | 'applied' | 'failed'): HumanRestoreStatus {
  if (status === 'failed') return 'Falhou'
  if (status === 'applied') return 'Restaurado'
  return 'Restaurando' // pending | claimed
}
