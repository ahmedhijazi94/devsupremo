import { afterEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { browserOperation } from './browser-operation'
afterEach(() => vi.unstubAllGlobals())
describe('browser operation identity', () => {
  it('resumes the exact scoped payload without saving its contents, until confirmed', async () => {
    const entries = new Map<string, string>()
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => entries.get(key), setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key) })
    const first = await browserOperation('project-a', { path: 'private-document', content: 'private-value' })
    expect((await browserOperation('project-a', { path: 'private-document', content: 'private-value' })).id).toBe(first.id)
    expect(JSON.stringify([...entries])).not.toMatch(/private-document|private-value/)
    expect((await browserOperation('project-b', { path: 'private-document', content: 'private-value' })).id).not.toBe(first.id)
    expect((await browserOperation('project-a', { path: 'private-document', content: 'changed' })).id).not.toBe(first.id)
    first.confirmed()
    expect((await browserOperation('project-a', { path: 'private-document', content: 'private-value' })).id).not.toBe(first.id)
  })
  it('does not dispatch with ephemeral identity if the browser storage is unavailable', async () => {
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('unavailable') } })
    await expect(browserOperation('project', {})).rejects.toThrow('unavailable')
  })
})
