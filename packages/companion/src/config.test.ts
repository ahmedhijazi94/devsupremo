import { describe, it, expect } from 'vitest'
import { loadConfig } from './config'

describe('loadConfig', () => {
  it('lê da env e normaliza a URL', () => {
    const cfg = loadConfig({
      SUPREMO_URL: 'https://x.vercel.app/',
      SUPREMO_TOKEN: 'sup_teste123456',
      SUPREMO_WORKSPACE_BASE: '/tmp/ws',
    } as NodeJS.ProcessEnv)
    expect(cfg.supremoUrl).toBe('https://x.vercel.app')
    expect(cfg.token).toBe('sup_teste123456')
    expect(cfg.workspaceBase).toBe('/tmp/ws')
  })

  it('exige token', () => {
    expect(() =>
      loadConfig({ SUPREMO_URL: 'https://x' } as NodeJS.ProcessEnv),
    ).toThrow(/TOKEN/)
  })
})
