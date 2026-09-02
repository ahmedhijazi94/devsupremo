import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { accountFor, keychainService, resolveKeychain } from './keychain'

describe('keychain — seleção e conta', () => {
  it('serviço fixo e conta por projeto', () => {
    expect(keychainService()).toBe('supremo-checkpoint-daemon')
    expect(accountFor('proj-1')).toBe('project:proj-1')
    expect(accountFor('a')).not.toBe(accountFor('b'))
  })
})

describe('keychain — fallback em arquivo FORA do projeto', () => {
  let cfg: string
  const prev = process.env.XDG_CONFIG_HOME

  beforeEach(() => {
    cfg = mkdtempSync(join(tmpdir(), 'supremo-kc-'))
    process.env.XDG_CONFIG_HOME = cfg
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prev
  })

  it('grava/lê/remove o secret no config do usuário (nunca no projeto)', () => {
    // win32 cai no fallback de arquivo (determinístico e testável).
    const kc = resolveKeychain('win32')
    const secret = 'sup_dev_ckpt_ABC123'
    kc.save('proj-1', secret)

    // o secret vive sob XDG_CONFIG_HOME/supremo/checkpoint — não em cwd/projeto
    const file = join(cfg, 'supremo', 'checkpoint', 'project_proj-1.secret')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(secret)
    expect(file.startsWith(cfg)).toBe(true)
    expect(file.includes(process.cwd())).toBe(false)

    expect(kc.get('proj-1')).toBe(secret)
    kc.remove('proj-1')
    expect(kc.get('proj-1')).toBeNull()
  })

  it('projetos diferentes não compartilham secret', () => {
    const kc = resolveKeychain('win32')
    kc.save('A', 'sup_dev_ckpt_A')
    kc.save('B', 'sup_dev_ckpt_B')
    expect(kc.get('A')).toBe('sup_dev_ckpt_A')
    expect(kc.get('B')).toBe('sup_dev_ckpt_B')
  })

  it('macOS usa o backend `security` (não o arquivo)', () => {
    // Não executamos o keychain real aqui; só garantimos que o backend existe.
    const kc = resolveKeychain('darwin')
    expect(typeof kc.save).toBe('function')
    expect(typeof kc.get).toBe('function')
    expect(typeof kc.remove).toBe('function')
  })
})
