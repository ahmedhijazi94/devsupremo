import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { OperationApprovalRequired, type OperationApproval } from './approval-contract'

interface ApprovalContext {
  ownerId: string; projectId: string; operationId: string; inputDigest: string
  review: OperationApproval['review']; expiresAt?: number; collecting: boolean; pending: boolean
}
const contexts = new AsyncLocalStorage<ApprovalContext>()
export function operationInputDigest(input: unknown): string {
  // Keep the historical receipt encoding. Changing it would invalidate retries
  // of operations created before one-time approvals were introduced.
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}
/** Deliberately never persist secret values or executable source in the review.
 * The full input is bound by digest; source artifacts are named and fingerprinted. */
export function operationReview(input: unknown): OperationApproval['review'] {
  const entries: OperationApproval['review'] = []
  const visit = (value: unknown, path: string, depth: number) => {
    if (entries.length >= 99 || depth > 8 || value === undefined) return
    if (/(?:password|secret|token|authorization|credentialvalue|api.?key)/i.test(path.split('.').at(-1) ?? '')) {
      entries.push({ label: path.slice(0, 240), value: 'Valor protegido, vinculado ao pedido original.' }); return
    }
    if (typeof value === 'string' && /(?:content|source|body)$/i.test(path)) {
      entries.push({ label: path.slice(0, 240), value: `Conteúdo vinculado: ${Buffer.byteLength(value)} bytes · SHA-256 ${operationInputDigest(value)}` }); return
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key, depth + 1)
    } else entries.push({ label: path.slice(0, 240), value: String(value).slice(0, 2000) })
  }
  visit(input, '', 0)
  return entries
}
export function operationApprovalContext() { return contexts.getStore() }
export function operationAuthorizationContext(scope: { ownerId: string; projectId: string; id: string; input: unknown; review?: OperationApproval['review']; expiresAt?: number }) {
  const context: ApprovalContext = { ownerId: scope.ownerId, projectId: scope.projectId, operationId: scope.id,
    inputDigest: operationInputDigest(scope.input), review: scope.review ?? operationReview(scope.input), ...(scope.expiresAt ? { expiresAt: scope.expiresAt } : {}), collecting: true, pending: false }
  return {
    withAuthorizationContext<T>(run: () => Promise<T>): Promise<T> { return contexts.run({ ...context }, run) },
    async checkAuthorization() {
      const active = contexts.getStore()
      if (!active) throw new Error('Operation authorization context missing')
      active.collecting = false
      if (active.pending) throw new OperationApprovalRequired(active.operationId)
    },
  }
}
