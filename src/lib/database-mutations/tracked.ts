import 'server-only'
import { describeMutationPlan } from './service'
import { runAuthorizedMutation, type MutationAuthority } from './server'
import type { MutationOptions } from './contract'
import { MutationError } from './contract'
import { backendOperationStore } from '../backend-operations/store'
import { runTrackedOperation } from '../backend-operations/service'
import { authorizeProjectOperation } from '../backend-operations/server'
import { operationReview } from '../backend-operations/approval-context'

export async function runTrackedMutation(
  authority: MutationAuthority,
  options: MutationOptions,
): Promise<unknown> {
  if (options.operation === 'data-plan')
    return runAuthorizedMutation(authority, options)
  const plan = describeMutationPlan(options.planToken)
  if (
    plan.scope.ownerId !== authority.ownerId ||
    plan.scope.projectId !== authority.projectId ||
    plan.scope.projectRef !== authority.expectedRef
  )
    throw new MutationError('Plano de outro projeto ou ambiente.', 403)
  const receipt = await runTrackedOperation({
    ...backendOperationStore(authority.client, {
      ...authority,
      id: plan.planId,
      capability: plan.capability,
      input: options,
      review: operationReview(plan.reviewAction),
      expiresAt: plan.expiresAt,
    }),
    authorize: () =>
      authorizeProjectOperation(
        { ...authority, environment: 'development' },
        plan.capability,
        plan.effects,
      ),
    execute: async () => ({
      ...(await runAuthorizedMutation(authority, options)),
    }),
    verify: async (result) =>
      Boolean(
        result.data &&
        typeof result.data === 'object' &&
        'verified' in result.data &&
        result.data.verified === true,
      ),
  })
  return receipt.state === 'succeeded' && receipt.result
    ? { ...receipt.result, receipt }
    : {
        operation: options.operation,
        projectId: authority.projectId,
        projectRef: authority.expectedRef,
        environment: 'development',
        receipt,
      }
}
