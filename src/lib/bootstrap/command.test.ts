import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootstrapCommand } from './command'
import { CLI_PACKAGE } from './cli-package'

describe('bootstrapCommand', () => {
  it('usa a CLI do próprio Supremo em URL identificada pelo hash do artefato', () => {
    const cmd = bootstrapCommand('proj-123', 'https://supremo.app')
    expect(cmd).toMatch(/npx --yes --package 'https:\/\/supremo.app\/api\/cli\/[a-f0-9]{64}\.tgz' supremo bootstrap proj-123/)
    expect(cmd).not.toContain('@latest')
  })
  it('normaliza barra final e mantém URL entre aspas de shell', () => {
    expect(bootstrapCommand('p', 'https://x.com/')).toBe(bootstrapCommand('p', 'https://x.com'))
    expect(bootstrapCommand('p', 'https://x.com')).toContain("--url 'https://x.com'")
  })
  it('recusa IDs e protocolos que não podem virar comando', () => {
    expect(() => bootstrapCommand('p; whoami', 'https://x.com')).toThrow()
    expect(() => bootstrapCommand('p', 'file:///tmp')).toThrow()
  })
  it('não inclui credencial no comando', () => {
    expect(bootstrapCommand('abc', 'http://localhost:3000')).not.toMatch(/token|secret/)
  })
})

describe('CLI_PACKAGE ↔ package.json (sem drift)', () => {
  const pkg = JSON.parse(
    readFileSync(join(process.cwd(), 'packages/cli/package.json'), 'utf8'),
  ) as { name: string; bin?: Record<string, string> }

  it('o package publicado tem exatamente o name canônico', () => {
    expect(pkg.name).toBe(CLI_PACKAGE)
  })

  it('CLI_PACKAGE não é um placeholder inexistente', () => {
    expect(CLI_PACKAGE).toBeTruthy()
    expect(CLI_PACKAGE).not.toBe('@supremo/cli')
    expect(CLI_PACKAGE).not.toMatch(/example|placeholder|TODO/i)
  })

  it('o package expõe o binário `supremo`', () => {
    expect(pkg.bin?.supremo).toBeTruthy()
  })
})
