import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readStableFile } from './stable-file'

let cwd: string
let file: string
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-stable-file-'))
  file = path.join(cwd, 'input.json')
  fs.writeFileSync(file, 'original', { mode: 0o600 })
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(cwd, { recursive: true, force: true }) })

describe('bounded descriptor-backed file reads', () => {
  it('reads bytes and permissions from one descriptor and closes it', () => {
    const open = vi.spyOn(fs, 'openSync'), close = vi.spyOn(fs, 'closeSync')
    expect(readStableFile(file, 8, cwd)).toEqual({ content: 'original', mode: fs.statSync(file).mode })
    expect(open).toHaveBeenCalledExactlyOnceWith(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    expect(close).toHaveBeenCalledExactlyOnceWith(open.mock.results[0]!.value)
  })
  it('refuses symbolic links at the leaf and in a parent before reading contents', () => {
    const leaf = path.join(cwd, 'leaf.json'), parent = path.join(cwd, 'linked')
    fs.symlinkSync(file, leaf)
    fs.symlinkSync(cwd, parent)
    const read = vi.spyOn(fs, 'readSync')
    expect(() => readStableFile(leaf, 64, cwd)).toThrow()
    expect(() => readStableFile(path.join(parent, 'input.json'), 64, cwd)).toThrow('link simbólico')
    expect(read).not.toHaveBeenCalled()
  })
  it('refuses directories and FIFOs without blocking on the pipe', () => {
    expect(() => readStableFile(cwd, 64)).toThrow('regular')
    const fifo = path.join(cwd, 'pipe')
    execFileSync('mkfifo', [fifo])
    expect(() => readStableFile(fifo, 64, cwd)).toThrow('regular')
  })
  it.each(['symlink', 'regular'])('rejects %s replacement after fstat and never reads the replacement', (kind) => {
    const target = path.join(cwd, 'different.json')
    fs.writeFileSync(target, 'untrusted')
    const fstat = fs.fstatSync
    vi.spyOn(fs, 'fstatSync').mockImplementationOnce((fd) => {
      const stat = fstat(fd)
      fs.renameSync(file, path.join(cwd, 'original.json'))
      if (kind === 'symlink') fs.symlinkSync(target, file)
      else fs.copyFileSync(target, file)
      return stat
    })
    const read = vi.spyOn(fs, 'readSync'), close = vi.spyOn(fs, 'closeSync')
    expect(() => readStableFile(file, 64, cwd)).toThrow('mudou')
    expect(read).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })
  it('caps growth that occurs after the descriptor size check', () => {
    const fstat = fs.fstatSync
    vi.spyOn(fs, 'fstatSync').mockImplementationOnce((fd) => {
      const stat = fstat(fd)
      fs.appendFileSync(file, 'x'.repeat(128))
      return stat
    })
    expect(() => readStableFile(file, 16, cwd)).toThrow('orçamento')
  })
  it('rejects same-length writes and parent swaps during the actual descriptor read', () => {
    const read = fs.readSync
    vi.spyOn(fs, 'readSync').mockImplementationOnce((...args) => {
      const count = Reflect.apply(read, fs, args) as number
      fs.writeFileSync(file, 'modified')
      fs.utimesSync(file, new Date(), new Date(Date.now() + 5000))
      return count
    })
    expect(() => readStableFile(file, 64, cwd)).toThrow('alterado')
    vi.restoreAllMocks()
    const directory = path.join(cwd, 'nested')
    fs.mkdirSync(directory)
    const nested = path.join(directory, 'file')
    fs.writeFileSync(nested, 'content')
    vi.spyOn(fs, 'readSync').mockImplementationOnce((...args) => {
      const count = Reflect.apply(read, fs, args) as number
      fs.renameSync(directory, path.join(cwd, 'old'))
      fs.mkdirSync(directory)
      fs.writeFileSync(nested, 'content')
      return count
    })
    expect(() => readStableFile(nested, 64, cwd)).toThrow('Diretório mudou')
  })
  it('rejects invalid budgets, oversized files and paths outside the authorized root', () => {
    expect(() => readStableFile(file, 0)).toThrow('Limite')
    expect(() => readStableFile(file, 7)).toThrow('orçamento')
    expect(() => readStableFile(file, 64, path.join(cwd, 'elsewhere'))).toThrow('fora')
    fs.writeFileSync(file, '')
    expect(readStableFile(file, 64, cwd).content).toBe('')
  })
})
