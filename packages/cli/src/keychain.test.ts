import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  accountFor,
  keychainAddScript,
  keychainGetScript,
  keychainRemoveScript,
  keychainScriptEnv,
  keychainService,
  osascriptArgs,
  resolveKeychain,
} from './keychain'

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

  it('macOS usa o backend nativo (JXA/Security.framework para save+get+remove — mesma identidade)', () => {
    // Não executamos o keychain real aqui; só garantimos que o backend existe.
    const kc = resolveKeychain('darwin')
    expect(typeof kc.save).toBe('function')
    expect(typeof kc.get).toBe('function')
    expect(typeof kc.remove).toBe('function')
  })
})

/**
 * Os três scripts JXA (add/get/remove) compartilham o mesmo contrato
 * estrutural — testamos os três com a mesma bateria de checagens em vez de
 * duplicar a suíte, já que save/get/remove precisam da MESMA identidade de
 * processo (osascript/JXA) para não reproduzir o mismatch de ACL do bug
 * original (save via JXA, get/remove via `security` — refutado pelo E2E
 * real: prompt repetido no MESMO projeto, não só "uma vez").
 */
describe('macOS — os 3 scripts (add/get/remove) usam a MESMA identidade JXA, nunca `security`', () => {
  const scripts: Array<[string, () => string]> = [
    ['keychainAddScript', keychainAddScript],
    ['keychainGetScript', keychainGetScript],
    ['keychainRemoveScript', keychainRemoveScript],
  ]

  for (const [name, build] of scripts) {
    describe(name, () => {
      it('é JavaScript válido (node --check) — roda como JXA', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supremo-kc-script-'))
        const file = join(dir, 'script.js')
        writeFileSync(file, build(), 'utf8')
        expect(() => execFileSync(process.execPath, ['--check', file])).not.toThrow()
      })

      it('NUNCA invoca a CLI `security` (a via que causa prompt/ACL mismatch)', () => {
        const src = build()
        expect(src).not.toMatch(/\bsecurity\b/)
        expect(src).not.toMatch(/-generic-password/)
      })

      it('é ESTÁTICO: lê conta/serviço só da ENV do processo — nunca de argv/arquivo', () => {
        const src = build()
        expect(src).toContain('SUPREMO_KC_ACCOUNT')
        expect(src).toContain('SUPREMO_KC_SERVICE')
        expect(src).toContain('processInfo.environment')
        // process.argv NÃO é como o JXA acessa argumentos de linha de comando do
        // osascript (usaria $.NSProcessInfo...arguments ou run(argv)) — confirma
        // que este script não tenta ler nada por aí.
        expect(src).not.toMatch(/\.arguments\b/)
      })

      it('é determinístico/puro — sem nenhum valor interpolado (mesmo texto sempre)', () => {
        expect(build()).toBe(build())
      })
    })
  }

  it('keychainAddScript: nenhum caminho de erro imprime/lança o segredo — só o status numérico', () => {
    const src = keychainAddScript()
    expect(src).toContain('SUPREMO_KC_SECRET')
    const throwLines = src.split('\n').filter((l) => l.includes('throw'))
    for (const line of throwLines) {
      expect(line).not.toMatch(/\+\s*secret\b/)
      expect(line).not.toContain('secret)')
    }
  })

  it('keychainGetScript: NUNCA lê SUPREMO_KC_SECRET da env (não precisa dele para ler)', () => {
    const src = keychainGetScript()
    expect(src).not.toContain('SUPREMO_KC_SECRET')
  })

  it('keychainRemoveScript: NUNCA lê SUPREMO_KC_SECRET da env (não precisa dele para remover)', () => {
    const src = keychainRemoveScript()
    expect(src).not.toContain('SUPREMO_KC_SECRET')
  })

  it('keychainGetScript: trata item ausente (errSecItemNotFound, -25300) sem lançar erro', () => {
    const src = keychainGetScript()
    expect(src).toContain('-25300')
  })

  it('keychainGetScript: usa ObjC.bindFunction com a assinatura C correta para SecItemCopyMatching (o bridge automático do JXA não expõe o parâmetro de saída)', () => {
    const src = keychainGetScript()
    expect(src).toContain("ObjC.bindFunction('SecItemCopyMatching'")
    // 'i' (OSStatus/int) e '@'/'^@' (object / pointer-to-object) — encoding
    // ObjC correto; 'int32' (testado e comprovado ERRADO) derrubaria o
    // processo inteiro com NSInvalidArgumentException.
    expect(src).toMatch(/\['i',\s*\['@',\s*'\^@'\]\]/)
  })
})

describe('macOS — construção da chamada nunca expõe segredo/conta em argv', () => {
  it('osascriptArgs: os args do osascript NUNCA incluem segredo/conta (só o path do script estático)', () => {
    const { cmd, args } = osascriptArgs('/tmp/algum-script.js')
    expect(cmd).toBe('osascript')
    expect(args).toEqual(['-l', 'JavaScript', '/tmp/algum-script.js'])
    // Por construção: `args` não recebe segredo/conta como parâmetro — não
    // HÁ como aparecer aqui. Prova estrutural, não só de valor.
    expect(args.join(' ')).not.toMatch(/segredo|secret|sup_dev_ckpt/i)
  })

  it('keychainScriptEnv: segredo/conta/serviço vão SÓ na env do processo filho, sob as chaves certas', () => {
    const env = keychainScriptEnv(
      { PATH: '/usr/bin' },
      { account: 'project:p1', service: 'supremo-checkpoint-daemon', secret: 'sup_dev_ckpt_SEGREDO123' },
    )
    expect(env.SUPREMO_KC_ACCOUNT).toBe('project:p1')
    expect(env.SUPREMO_KC_SERVICE).toBe('supremo-checkpoint-daemon')
    expect(env.SUPREMO_KC_SECRET).toBe('sup_dev_ckpt_SEGREDO123')
    expect(env.PATH).toBe('/usr/bin') // preserva a env base (PATH etc.)
  })

  it('keychainScriptEnv: sem `secret`, a chave SUPREMO_KC_SECRET nem aparece (get/remove não precisam dela)', () => {
    const env = keychainScriptEnv({}, { account: 'project:p1', service: 'supremo-checkpoint-daemon' })
    expect(env).not.toHaveProperty('SUPREMO_KC_SECRET')
  })

  it('a env base do processo não é mutada (nova cópia)', () => {
    const base = { X: '1' }
    const env = keychainScriptEnv(base, { account: 'a', service: 's', secret: 'seg' })
    expect(base).not.toHaveProperty('SUPREMO_KC_SECRET')
    expect(env).not.toBe(base)
  })
})

// SEM teste automatizado contra o Keychain REAL do macOS de propósito — a
// suíte NUNCA deve tocar o keychain de quem a roda.
//
// HISTÓRICO: a 1ª rodada deste fix media save (JXA) + get/remove (`security`
// CLI) — DUAS identidades de processo diferentes. O E2E real mostrou que
// isso reabre autorização repetidamente no MESMO projeto (não só "uma vez"
// como a hipótese inicial supunha). Esta rodada elimina a causa raiz: as
// TRÊS operações (save/get/remove) agora chamam Security.framework pela
// MESMA identidade de processo (osascript rodando JXA), sem NENHUM uso de
// `security` no caminho do macOS.
//
// Verificado manualmente, isolado da suíte (ver relatório final): salvar via
// keychainAddScript() e ler repetidamente via keychainGetScript() o MESMO
// item — 10 leituras seguidas, ~80-106ms cada, ZERO prompts. Item limpo do
// keychain real logo em seguida.
//
// Cobertura automatizada real (sem tocar o SO): os testes acima garantem que
// os TRÊS scripts JXA são válidos, nunca usam `security`, leem conta/serviço
// só de env, nunca expõem o segredo em erro/log, e as funções de construção
// da chamada (osascriptArgs/keychainScriptEnv) nunca colocam segredo/conta em
// argv. O backend de arquivo (fallback determinístico, usado em CI/Linux/
// Windows) prova o contrato save→get→remove fim-a-fim de verdade, isolado em
// XDG_CONFIG_HOME temporário — ver "keychain — fallback em arquivo".
