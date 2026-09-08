import { createHash } from 'node:crypto'

export interface ValidationManifest {
  version: string
  kind: string
  files: Record<string, string>
  scripts: Record<string, string>
  devDependencies: Record<string, string>
  lock: Record<string, string>
}
export interface PolicyTreeEntry { path: string; sha: string; mode: string }

export function blobHash(content: string): string {
  const bytes = Buffer.from(content)
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => `${JSON.stringify(key)}:${stable(val)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

export function lockEntryHash(value: unknown): string {
  const entry = record(value)
  // npm may change classification when the app adds a dependency on a tool.
  const identity = Object.fromEntries(Object.entries(entry).filter(([key]) => !['dev', 'optional', 'devOptional'].includes(key)))
  return createHash('sha256').update(stable(identity)).digest('hex')
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function binNames(path: string, value: unknown): string[] {
  const bin = record(value).bin
  const names = typeof bin === 'string' ? [path.split('/').at(-1) ?? '']
    : Array.isArray(bin) ? bin.filter((name): name is string => typeof name === 'string') : Object.keys(record(bin))
  // npm normalizes bin keys to their final path component.
  return names.map(name => name.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '').filter(Boolean)
}

/** Policy comes from the installed engine, NEVER from a candidate-owned file. */
export function inspectValidationIntegrity(
  manifest: ValidationManifest,
  tree: readonly PolicyTreeEntry[],
  packageContent: string,
  lockContent: string,
): string[] {
  const failures: string[] = []
  const byPath = new Map(tree.map((entry) => [entry.path, entry]))
  for (const [path, sha] of Object.entries(manifest.files)) {
    const entry = byPath.get(path)
    if (!entry || entry.sha !== sha || !['100644', '100755'].includes(entry.mode)) failures.push(`Validador ausente ou alterado: ${path}`)
  }
  for (const entry of tree) {
    if ((entry.path.startsWith('.github/workflows/') && !manifest.files[entry.path]) ||
      /(^|\/)node_modules\//.test(entry.path) || /(^|\/)\.npmrc$/.test(entry.path)) failures.push(`Configuração de execução não autorizada: ${entry.path}`)
  }
  for (const path of ['package.json', 'package-lock.json']) {
    const content = path === 'package.json' ? packageContent : lockContent
    const entry = byPath.get(path)
    if (!entry || entry.sha !== blobHash(content) || entry.mode !== '100644') failures.push(`Metadados não correspondem ao snapshot: ${path}`)
  }
  try {
    const pkg = record(JSON.parse(packageContent))
    const scripts = record(pkg.scripts)
    for (const [name, expected] of Object.entries(manifest.scripts)) {
      if (scripts[name] !== expected) failures.push(`Comando de validação alterado: ${name}`)
      for (const hook of [`pre${name}`, `post${name}`]) if (hook in scripts) failures.push(`Hook de validação não autorizado: ${hook}`)
    }
    for (const name of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'preprepare', 'postprepare']) {
      if (name in scripts) failures.push(`Hook de instalação não autorizado: ${name}`)
    }
    for (const name of ['overrides', 'workspaces', 'resolutions', 'pnpm']) if (name in pkg) failures.push(`Resolução das ferramentas não autorizada: ${name}`)
    const dev = record(pkg.devDependencies)
    for (const [name, expected] of Object.entries(manifest.devDependencies)) {
      if (dev[name] !== expected || name in record(pkg.dependencies) || name in record(pkg.optionalDependencies)) failures.push(`Ferramenta de validação alterada: ${name}`)
    }
    const lock = record(JSON.parse(lockContent))
    if (lock.lockfileVersion !== 3) failures.push('Lockfile de validação incompatível.')
    const packages = record(lock.packages)
    for (const [path, expected] of Object.entries(manifest.lock)) {
      if (!packages[path] || lockEntryHash(packages[path]) !== expected) failures.push(`Dependência protegida alterada: ${path}`)
    }
    const protectedBins = new Set(Object.keys(manifest.lock).flatMap(path => binNames(path, packages[path])))
    // A new nested install can shadow an unchanged, pinned transitive package.
    // Node resolves from the importing tool outward, so protecting only existing
    // paths is insufficient. Extra app dependencies may not enter a tool's tree.
    for (const path of Object.keys(packages)) {
      if (path in manifest.lock) continue
      if (binNames(path, packages[path]).some(name => protectedBins.has(name))) {
        failures.push(`Executável colide com ferramenta protegida: ${path}`)
      }
      let ancestor = path
      for (;;) {
        const nested = ancestor.lastIndexOf('/node_modules/')
        if (nested < 0) break
        ancestor = ancestor.slice(0, nested)
        if (ancestor in manifest.lock) {
          failures.push(`Dependência sombreia ferramenta protegida: ${path}`)
          break
        }
      }
    }
  } catch { failures.push('Manifesto de dependências inválido.') }
  return failures
}
