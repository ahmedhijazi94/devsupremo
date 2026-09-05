import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { drainDatabaseRequests, requestDatabase, startDatabaseWorker } from './database-queue'

const dirs: string[] = []
const stops: Array<() => void> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-db-queue-'))
  dirs.push(cwd)
  fs.mkdirSync(path.join(cwd, '.supremo/database-queue'), { recursive: true })
  return cwd
}
it('agente sem keychain recebe resultado do daemon e não grava credenciais', async () => {
  const cwd = workspace()
  const execute = vi.fn(async () => ({ applied: ['migration.sql'] }))
  stops.push(startDatabaseWorker(cwd, execute))
  await expect(requestDatabase(cwd, 'migrate')).resolves.toEqual({ applied: ['migration.sql'] })
  expect(execute).toHaveBeenCalledExactlyOnceWith('migrate')
  expect(fs.readdirSync(path.join(cwd, '.supremo/database-queue'))).toEqual(['heartbeat'])
})
it('propaga recusa do servidor sem fallback ou sucesso falso', async () => {
  const cwd = workspace()
  stops.push(startDatabaseWorker(cwd, async () => { throw new Error('Dispositivo revogado') }))
  await expect(requestDatabase(cwd, 'anonymous-auth')).rejects.toThrow('Dispositivo revogado')
})
it('daemon antigo ou ausente falha imediatamente sem pedir bootstrap', async () => {
  await expect(requestDatabase(workspace(), 'status')).rejects.toThrow('Não é necessário refazer o bootstrap')
})
it('não executa pedidos vencidos nem campos que tentam escolher comando ou alvo', async () => {
  const cwd = workspace()
  const dir = path.join(cwd, '.supremo/database-queue')
  for (const body of [
    { operation: 'migrate', expiresAt: Date.now() - 1 },
    { operation: 'shell', expiresAt: Date.now() + 1000 },
    { operation: 'migrate', expiresAt: Date.now() + 1000, expectedRef: 'production' },
    { operation: 'migrate', expiresAt: Date.now() + 100_000 },
  ]) fs.writeFileSync(path.join(dir, `${randomUUID()}.request.json`), JSON.stringify(body))
  const execute = vi.fn()
  await drainDatabaseRequests(cwd, execute)
  expect(execute).not.toHaveBeenCalled()
})
it('uma operação lenta não é executada novamente em cada tick', async () => {
  const cwd = workspace()
  const execute = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 800))
    return { anonymousAuth: true }
  })
  stops.push(startDatabaseWorker(cwd, execute))
  await requestDatabase(cwd, 'anonymous-auth')
  expect(execute).toHaveBeenCalledTimes(1)
})
