import { describe, expect, it } from 'vitest'
import { blobHash, inspectValidationIntegrity, type PolicyTreeEntry, type ValidationManifest } from './validation-integrity'

const approvedOverrides = { '@next/eslint-plugin-next': { 'fast-glob': '$fast-glob' } }
const adapterFiles = {
  'tools/next-eslint-glob/package.json': '{"name":"fast-glob","main":"index.cjs"}',
  'tools/next-eslint-glob/index.cjs': 'module.exports = { sync: require("node:fs").globSync }',
}
const manifest: ValidationManifest = {
  version: 'fixture', kind: 'solo', scripts: {}, lock: {},
  files: Object.fromEntries(Object.entries(adapterFiles).map(([path, content]) => [path, blobHash(content)])),
  devDependencies: { 'fast-glob': 'file:tools/next-eslint-glob' },
  overrides: approvedOverrides,
}

function inspect(pkg: Record<string, unknown>, policy: ValidationManifest = manifest, editTree?: (tree: PolicyTreeEntry[]) => PolicyTreeEntry[]): string[] {
  const packageContent = JSON.stringify({ devDependencies: manifest.devDependencies, ...pkg })
  const lockContent = JSON.stringify({ lockfileVersion: 3, packages: {} })
  const tree = Object.entries({ ...adapterFiles, 'package.json': packageContent, 'package-lock.json': lockContent })
    .map(([path, content]) => ({ path, sha: blobHash(content), mode: '100644' }))
  return inspectValidationIntegrity(policy, editTree ? editTree(tree) : tree, packageContent, lockContent)
}

describe('engine-owned dependency overrides', () => {
  it('accepts only the exact approved override without relaxing dependency pins', () => {
    expect(inspect({ overrides: approvedOverrides })).toEqual([])
    expect(inspect({ overrides: approvedOverrides, devDependencies: { 'fast-glob': 'file:tools/other-glob' } }))
      .toContain('Ferramenta de validação alterada: fast-glob')
  })

  it.each([
    {},
    { overrides: null },
    { overrides: [] },
    { overrides: {} },
    { overrides: { 'fast-glob': '$fast-glob' } },
    { overrides: { '@next/eslint-plugin-next': { 'fast-glob': 'file:tools/other-glob' } } },
    { overrides: { ...approvedOverrides, vitest: 'npm:fake-test@1.0.0' } },
    { overrides: { '@next/eslint-plugin-next': { 'fast-glob': '$fast-glob', other: 'npm:fake@1.0.0' } } },
  ])('rejects missing, malformed, broadened or additional overrides %#', pkg => {
    expect(inspect(pkg)).toContain('Resolução das ferramentas não autorizada: overrides')
  })

  it('compares canonical object content independently of property order', () => {
    const policy = { ...manifest, overrides: { tool: { first: '1.0.0', second: '2.0.0' }, another: '3.0.0' } }
    expect(inspect({ overrides: { another: '3.0.0', tool: { second: '2.0.0', first: '1.0.0' } } }, policy)).toEqual([])
  })

  it('keeps historical releases closed to every override, including the new approved one', () => {
    const historical = { ...manifest }
    delete historical.overrides
    expect(inspect({}, historical)).toEqual([])
    for (const overrides of [approvedOverrides, {}, null, []]) {
      expect(inspect({ overrides }, historical)).toContain('Resolução das ferramentas não autorizada: overrides')
    }
  })

  it.each(Object.keys(adapterFiles))('rejects missing, changed and symlinked adapter authority: %s', path => {
    for (const editTree of [
      (tree: PolicyTreeEntry[]) => tree.filter(entry => entry.path !== path),
      (tree: PolicyTreeEntry[]) => tree.map(entry => entry.path === path ? { ...entry, sha: blobHash('malicious adapter') } : entry),
      (tree: PolicyTreeEntry[]) => tree.map(entry => entry.path === path ? { ...entry, mode: '120000' } : entry),
    ]) {
      expect(inspect({ overrides: approvedOverrides }, manifest, editTree)).toContain(`Validador ausente ou alterado: ${path}`)
    }
  })
})
