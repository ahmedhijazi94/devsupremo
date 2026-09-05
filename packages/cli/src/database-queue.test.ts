import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { drainDatabaseRequests, requestDatabase, startDatabaseWorker } from './database-queue'

const dirs: string[] = []
const stops: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const stop of stops.splice(0)) stop()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
it('recusa pedido que é symlink sem executar seu conteúdo', async () => {
  const cwd = workspace()
  const target = path.join(cwd, 'external.json')
  fs.writeFileSync(target, JSON.stringify({ operation: 'migrate', expiresAt: Date.now() + 5000 }))
  fs.symlinkSync(target, path.join(cwd, '.supremo/database-queue', `${randomUUID()}.request.json`))
  const execute = vi.fn()
  await drainDatabaseRequests(cwd, execute)
  expect(execute).not.toHaveBeenCalled()
})
it('trocar o caminho após fstat não troca o arquivo lido pelo daemon', async () => {
  const cwd = workspace()
  const request = path.join(cwd, '.supremo/database-queue', `${randomUUID()}.request.json`)
  const target = path.join(cwd, 'replacement.json')
  fs.writeFileSync(request, JSON.stringify({ operation: 'status', expiresAt: Date.now() + 5000 }))
  fs.writeFileSync(target, JSON.stringify({ operation: 'migrate', expiresAt: Date.now() + 5000 }))
  const fstat = fs.fstatSync
  vi.spyOn(fs, 'fstatSync').mockImplementationOnce((fd) => {
    const stat = fstat(fd)
    fs.renameSync(request, path.join(cwd, 'original.json'))
    fs.symlinkSync(target, request)
    return stat
  })
  const execute = vi.fn(async () => ({}))
  await drainDatabaseRequests(cwd, execute)
  expect(execute).toHaveBeenCalledExactlyOnceWith('status')
})
it('recusa arquivo que cresce além do limite depois do fstat', async () => {
  const cwd = workspace()
  const request = path.join(cwd, '.supremo/database-queue', `${randomUUID()}.request.json`)
  fs.writeFileSync(request, JSON.stringify({ operation: 'migrate', expiresAt: Date.now() + 5000 }))
  const fstat = fs.fstatSync
  vi.spyOn(fs, 'fstatSync').mockImplementationOnce((fd) => {
    const stat = fstat(fd)
    fs.appendFileSync(request, ' '.repeat(2048))
    return stat
  })
  const execute = vi.fn()
  await drainDatabaseRequests(cwd, execute)
  expect(execute).not.toHaveBeenCalled()
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
