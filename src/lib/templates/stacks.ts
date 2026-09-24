import { stackForVersion, type ProjectStack } from '../../../packages/cli/src/project-stack'

export { resolveProjectStack, stackForVersion, type ProjectStack } from '../../../packages/cli/src/project-stack'

export const NEXT_TEMPLATE_VERSION = '4.0.14'
export const START_TEMPLATE_VERSION = '5.1.2'

// Activation is a release decision after real acceptance, separate from legacy resolution.
export const DEFAULT_NEW_PROJECT_STACK: ProjectStack = 'tanstack-start-vite'

export function templateVersionFor(stack: ProjectStack): string {
  return stack === 'nextjs' ? NEXT_TEMPLATE_VERSION : START_TEMPLATE_VERSION
}

/** Called only when inserting a NEW project; persist the returned version then. */
export function newProjectTemplateVersion(configured = process.env['SUPREMO_NEW_PROJECT_STACK']): string {
  const stack = configured ?? DEFAULT_NEW_PROJECT_STACK
  if (stack !== 'nextjs' && stack !== 'tanstack-start-vite') {
    throw new Error('SUPREMO_NEW_PROJECT_STACK deve ser nextjs ou tanstack-start-vite.')
  }
  return templateVersionFor(stack)
}

/** Old unprovisioned records predate stack selection and retain their Next template. */
export function provisioningTemplate(version: unknown): { stack: ProjectStack; version: string } {
  const stack = stackForVersion(version) ?? 'nextjs'
  return { stack, version: templateVersionFor(stack) }
}

export function latestTemplateVersion(version: unknown): string {
  return templateVersionFor(stackForVersion(version) ?? 'nextjs')
}
