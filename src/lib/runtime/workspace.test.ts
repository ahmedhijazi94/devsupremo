import { describe, it, expect } from 'vitest'
import {
  workspaceDir,
  detectPackageManager,
  installCommand,
  devCommand,
  safeEditPath,
  preferredPort,
} from './workspace'
import { parseCommand, parseEvent } from './protocol'

const USER = '11111111-1111-4111-8111-111111111111'
const PROJ_A = 'aaaaaaaa-1111-4111-8111-111111111111'
const PROJ_B = 'bbbbbbbb-2222-4222-8222-222222222222'

describe('workspaceDir — isolamento por user+project', () => {
  it('gera diretório isolado por projeto', () => {
    const a = workspaceDir('/srv/ws', USER, PROJ_A)
    const b = workspaceDir('/srv/ws', USER, PROJ_B)
    expect(a).toBe(`/srv/ws/${USER}/${PROJ_A}`)
    expect(a).not.toBe(b)
  })

  it('rejeita id adulterado (sem chance de subir de diretório)', () => {
    expect(() => workspaceDir('/srv/ws', USER, '../etc')).toThrow()
    expect(() => workspaceDir('/srv/ws', '..', PROJ_A)).toThrow()
    expect(() => workspaceDir('/srv/ws', USER, `${PROJ_A}/../../x`)).toThrow()
  })
})

describe('detectPackageManager — não assume npm', () => {
  it('pnpm pelo lockfile', () => {
    expect(detectPackageManager(['pnpm-lock.yaml', 'package.json'])).toBe('pnpm')
  })
  it('yarn pelo lockfile', () => {
    expect(detectPackageManager(['yarn.lock', 'package.json'])).toBe('yarn')
  })
  it('npm por padrão', () => {
    expect(detectPackageManager(['package-lock.json'])).toBe('npm')
    expect(detectPackageManager([])).toBe('npm')
  })
  it('comandos batem com o gerenciador', () => {
    expect(installCommand('pnpm')[0]).toBe('pnpm')
    expect(devCommand('yarn')).toEqual(['yarn', 'dev'])
    expect(devCommand('npm')).toEqual(['npm', 'run', 'dev'])
  })
})

describe('safeEditPath — a fronteira do apply_edits', () => {
  const ws = `/srv/ws/${USER}/${PROJ_A}`

  it('aceita caminho normal dentro do projeto', () => {
    expect(safeEditPath(ws, 'app/page.tsx')).toBe(`${ws}/app/page.tsx`)
  })

  it('rejeita traversal para fora do projeto', () => {
    expect(() => safeEditPath(ws, '../../etc/passwd')).toThrow()
    expect(() => safeEditPath(ws, '../../')).toThrow()
  })

  it('rejeita escrever em OUTRO projeto', () => {
    expect(() => safeEditPath(ws, `../${PROJ_B}/app/page.tsx`)).toThrow()
  })

  it('rejeita caminho absoluto e NUL', () => {
    expect(() => safeEditPath(ws, '/etc/hosts')).toThrow()
    expect(() => safeEditPath(ws, 'app/\0.tsx')).toThrow()
  })
})

describe('preferredPort', () => {
  it('é determinística por projeto e dentro da faixa', () => {
    expect(preferredPort(PROJ_A)).toBe(preferredPort(PROJ_A))
    const p = preferredPort(PROJ_A)
    expect(p).toBeGreaterThanOrEqual(3100)
    expect(p).toBeLessThan(3900)
  })
})

describe('protocolo — parse defensivo', () => {
  it('aceita um comando válido e rejeita lixo', () => {
    const ok = parseCommand({
      type: 'apply_edits',
      projectId: PROJ_A,
      edits: [{ path: 'app/page.tsx', content: 'x' }],
    })
    expect(ok?.type).toBe('apply_edits')
    expect(parseCommand({ type: 'nao_existe' })).toBeNull()
    expect(parseCommand({ type: 'start_project' })).toBeNull() // faltam campos
  })

  it('aceita um evento válido e rejeita lixo', () => {
    const ok = parseEvent({
      type: 'preview_ready',
      projectId: PROJ_A,
      url: 'http://localhost:3123',
      port: 3123,
    })
    expect(ok?.type).toBe('preview_ready')
    expect(parseEvent({ type: 'boom' })).toBeNull()
  })
})
