import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootstrapCommand } from './command'
import { CLI_PACKAGE } from './cli-package'

describe('bootstrapCommand', () => {
  it('usa o package CANÔNICO (CLI_PACKAGE), não um hardcode', () => {
    const cmd = bootstrapCommand('proj-123', 'https://supremo.app')
    expect(cmd).toBe(
      `npx ${CLI_PACKAGE}@latest bootstrap proj-123 --url https://supremo.app`,
    )
    // Regressão: nunca voltar ao package que não existe no npm.
    expect(cmd).not.toContain('@supremo/cli')
  })

  it('remove a barra final da url', () => {
    expect(bootstrapCommand('p', 'https://x.com/')).toBe(
      `npx ${CLI_PACKAGE}@latest bootstrap p --url https://x.com`,
    )
  })

  it('URL é crua — sem markdown, colchetes ou caracteres extras', () => {
    const cmd = bootstrapCommand('abc', 'https://supremo-three.vercel.app')
    expect(cmd).toContain('--url https://supremo-three.vercel.app')
    // nada de markdown/colchetes/backticks/parênteses ao redor da URL
    expect(cmd).not.toMatch(/[[\]()`<>]/)
    expect(cmd).not.toContain('](')
  })

  it('não embute segredo — só o project-id', () => {
    const cmd = bootstrapCommand('abc', 'http://localhost:3000')
    expect(cmd).not.toMatch(/token|secret|sup_/)
    expect(cmd).toContain('abc')
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
