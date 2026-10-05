import { z } from 'zod'

/** Transport acknowledgement is not the provider's completed response. */
export function isOperationReceipt(value: unknown): value is { operationId: string; status: string; pending: boolean; nextAction?: string } {
  return z.object({ operationId: z.string().uuid(), status: z.enum(['queued', 'running', 'uncertain', 'needs_authorization']), pending: z.boolean() }).safeParse(value).success
}
