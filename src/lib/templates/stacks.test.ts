import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  newProjectTemplateVersion, provisioningTemplate, latestTemplateVersion,
  resolveProjectStack, stackForVersion, START_TEMPLATE_VERSION,
} from './stacks'

afterEach(() => vi.unstubAllEnvs())

const startDependencies = { '@tanstack/react-start': '1.168.57', '@tanstack/react-router': '1.170.38', vite: '8.3.0' }

describe('framework selection is immutable after creation', () => {
  it('selects Start for new projects and respects an explicit future-creation rollback', () => {
    vi.stubEnv('SUPREMO_NEW_PROJECT_STACK', undefined)
    expect(newProjectTemplateVersion()).toBe('5.0.1')
    vi.stubEnv('SUPREMO_NEW_PROJECT_STACK', 'nextjs')
    expect(newProjectTemplateVersion()).toBe('4.0.11')
  })

  it('rollback changes only future insertions, not an already selected template', () => {
    const pinned = newProjectTemplateVersion('tanstack-start-vite')
    expect(pinned).toBe(START_TEMPLATE_VERSION)
    expect(newProjectTemplateVersion('nextjs')).toBe('4.0.11')
    expect(provisioningTemplate(pinned)).toEqual({ stack: 'tanstack-start-vite', version: '5.0.1' })
    expect(provisioningTemplate(null)).toEqual({ stack: 'nextjs', version: '4.0.11' })
    expect(latestTemplateVersion('4.0.8')).toBe('4.0.11')
    expect(latestTemplateVersion('5.0.0')).toBe('5.0.1')
    expect(() => newProjectTemplateVersion('vite --execute arbitrary')).toThrow()
  })

  it('metadata-less projects require actual dependencies, never the creation default', () => {
    expect(resolveProjectStack({ dependencies: { next: '^16' } })).toBe('nextjs')
    expect(resolveProjectStack({ devDependencies: startDependencies })).toBe('tanstack-start-vite')
    expect(resolveProjectStack({ dependencies: { vite: '8.3.0', react: '19' } })).toBeNull()
    expect(resolveProjectStack({})).toBeNull()
  })

  it('requires version, declaration and installed framework evidence to agree', () => {
    expect(resolveProjectStack({ dependencies: startDependencies, declaredStack: 'tanstack-start-vite', scaffoldVersion: '5.0.0' })).toBe('tanstack-start-vite')
    expect(() => resolveProjectStack({ dependencies: { next: '16', ...startDependencies } })).toThrow(/ambígua/)
    expect(() => resolveProjectStack({ dependencies: { '@tanstack/react-start': '1' } })).toThrow(/Router/)
    expect(() => resolveProjectStack({ dependencies: { next: '16' }, declaredStack: 'tanstack-start-vite' })).toThrow(/dependências/)
    expect(() => resolveProjectStack({ declaredStack: 'nextjs' })).toThrow(/dependências/)
    expect(() => resolveProjectStack({ declaredStack: 'nextjs', scaffoldVersion: '5.0.0' })).toThrow(/incompatíveis/)
    expect(() => resolveProjectStack({ declaredStack: 'arbitrary-command' })).toThrow(/reconhecida/)
    expect(() => stackForVersion('9.0.0')).toThrow(/reconhecida/)
    expect(() => stackForVersion(4)).toThrow(/inválida/)
    expect(stackForVersion('')).toBeNull()
    expect(latestTemplateVersion(undefined)).toBe('4.0.11')
  })
})
