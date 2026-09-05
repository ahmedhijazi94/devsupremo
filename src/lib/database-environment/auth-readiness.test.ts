import { expect, it, vi } from 'vitest'
import { waitForAnonymousAuth } from './auth-readiness'
it('aguarda propagação real e não atrasa configuração já efetiva', async () => {
  const read = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
  const pause = vi.fn(async () => {})
  await waitForAnonymousAuth(read, pause)
  expect(pause).toHaveBeenCalledTimes(1)
  await waitForAnonymousAuth(read, pause)
  expect(pause).toHaveBeenCalledTimes(1)
})
it('timeout ou indisponibilidade nunca vira sucesso', async () => {
  const pause = vi.fn(async () => {})
  await expect(waitForAnonymousAuth(async () => false, pause)).rejects.toThrow(/ainda não está disponível/)
  expect(pause).toHaveBeenCalledTimes(14)
  await expect(waitForAnonymousAuth(async () => { throw new Error('offline') }, pause)).rejects.toThrow(/offline/)
})
