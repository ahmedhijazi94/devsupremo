import { OperationError, type OperationReceipt } from './contract'
import { assertSamePolicy } from './policy'

export interface OperationPort {
  withAuthorizationContext?<T>(run: () => Promise<T>): Promise<T>
  checkAuthorization?(): Promise<void>
  authorize(): Promise<{ policyId: string; revision: string }>
  claim(authorization: { policyId: string; revision: string }): Promise<{ acquired: boolean; receipt: OperationReceipt; token: string }>
  update(id: string, token: string, state: OperationReceipt['state'], message: string, result?: Record<string, unknown>): Promise<OperationReceipt>
  execute(): Promise<Record<string, unknown>>
  verify(result: Record<string, unknown>): Promise<boolean>
}

/** A lost HTTP response is not evidence that an external write did not happen.
 * Keep an uncertain receipt, never claim it again, and require reconciliation. */
export async function runTrackedOperation(port: OperationPort): Promise<OperationReceipt> {
  if (port.withAuthorizationContext) {
    const { withAuthorizationContext, ...inner } = port
    return withAuthorizationContext(() => runTrackedOperation(inner))
  }
  const authorization = await port.authorize()
  await port.checkAuthorization?.()
  const claim = await port.claim(authorization)
  if (!claim.acquired) return claim.receipt
  let dispatched = false
  try {
    assertSamePolicy(authorization, await port.authorize())
    await port.update(claim.receipt.id, claim.token, 'running', 'Executando a operação autorizada.')
    dispatched = true
    const result = await port.execute()
    assertSamePolicy(authorization, await port.authorize())
    await port.update(claim.receipt.id, claim.token, 'verifying', 'Conferindo o resultado no provedor.')
    if (!await port.verify(result)) throw new OperationError('O provedor ainda não confirmou o efeito.')
    assertSamePolicy(authorization, await port.authorize())
    return await port.update(claim.receipt.id, claim.token, 'succeeded', 'Operação concluída e verificada.', result)
  } catch {
    return port.update(claim.receipt.id, claim.token, dispatched ? 'uncertain' : 'failed', dispatched
      ? 'Resultado ainda não confirmado. A operação não será repetida automaticamente; consulte o estado no provedor.'
      : 'A autorização ou a preparação mudou antes do envio. Prepare uma nova operação.')
  }
}
