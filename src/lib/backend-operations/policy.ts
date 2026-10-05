import { OperationError, type OperationCapability, type OperationPolicy } from './contract'

export interface PolicyScope { ownerId: string; projectId: string; environment: 'development' | 'production'; deviceId?: string; ownerSession?: true }
export function enforceOperationPolicy(policy: OperationPolicy | null, scope: PolicyScope, capability: OperationCapability, effects: { rows?: number; resource?: string } = {}) {
  if (!policy || !policy.enabled || policy.ownerId !== scope.ownerId || policy.projectId !== scope.projectId || policy.environment !== scope.environment)
    throw new OperationError('Autorize a automação deste ambiente na seção Automação do projeto Supremo. Nenhuma operação foi executada.', 403)
  if (!policy.capabilities.includes(capability)) throw new OperationError(`A política atual não permite ${capability}. O dono pode ajustar a autorização no Supremo.`, 403)
  if (policy.deviceIds.length && scope.ownerSession !== true && (!scope.deviceId || !policy.deviceIds.includes(scope.deviceId)))
    throw new OperationError('Este dispositivo não está incluído na autorização do projeto.', 403)
  if (effects.rows !== undefined && (!Number.isSafeInteger(effects.rows) || effects.rows < 0 || effects.rows > policy.maxRows))
    throw new OperationError(`O impacto excede o limite autorizado de ${policy.maxRows} registros.`, 403)
  if (policy.resources.length && (!effects.resource || !policy.resources.includes(effects.resource)))
    throw new OperationError('O recurso solicitado está fora da autorização do projeto.', 403)
  return { policyId: policy.id, revision: policy.revision }
}

export function assertSamePolicy(initial: { policyId: string; revision: string }, current: { policyId: string; revision: string }) {
  if (initial.policyId !== current.policyId || initial.revision !== current.revision)
    throw new OperationError('A autorização mudou durante o preparo. Atualize o plano antes de executar.', 409)
}
