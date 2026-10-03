import { TRUSTED_VALIDATION_POLICIES } from '../../../packages/cli/src/generated/validation-policy'
import { resolveProjectStack } from './stacks'

type JsonObject = Record<string, unknown>
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Manifesto de dependências inválido.')
  return value as JsonObject
}

function mergeManagedOverrides(current: JsonObject, target: JsonObject): JsonObject {
  const result = { ...current }
  for (const [name, value] of Object.entries(target)) {
    const existing = current[name]
    result[name] = typeof value === 'string' ? value : mergeManagedOverrides(
      existing && typeof existing === 'object' && !Array.isArray(existing) ? object(existing) : {},
      object(value),
    )
  }
  return result
}

/** Upgrade only platform-owned execution fields; preserve app dependencies. */
export function upgradeValidationPackages(currentPackage: string, currentLock: string, targetPackage: string, targetLock: string): { packageContent: string; lockContent: string } {
  const current = object(JSON.parse(currentPackage))
  const target = object(JSON.parse(targetPackage))
  const stackOf = (pkg: JsonObject) => resolveProjectStack({
    dependencies: object(pkg.dependencies ?? {}), devDependencies: object(pkg.devDependencies ?? {}),
  })
  if (stackOf(current) !== stackOf(target)) throw new Error('Atualizar a base não pode trocar a stack do projeto.')
  const scripts = { ...object(current.scripts ?? {}) }
  const targetScripts = object(target.scripts)
  const managedScripts = new Set(TRUSTED_VALIDATION_POLICIES.flatMap(policy => Object.keys(policy.scripts)))
  for (const name of managedScripts) {
    if (typeof targetScripts[name] !== 'string') continue
    scripts[name] = targetScripts[name]
    delete scripts[`pre${name}`]
    delete scripts[`post${name}`]
  }
  // Preserve installation hooks and extra overrides for explicit repair by
  // the independent gate; copy only the exact engine-owned override branches.
  const next: JsonObject = { ...current, scripts, dependencies: { ...object(current.dependencies ?? {}), ...object(target.dependencies) }, devDependencies: { ...object(current.devDependencies ?? {}), ...object(target.devDependencies) } }
  if (target.overrides !== undefined) {
    next.overrides = mergeManagedOverrides(object(current.overrides ?? {}), object(target.overrides))
  }
  const lock = object(JSON.parse(currentLock))
  const trustedLock = object(JSON.parse(targetLock))
  const packages = { ...object(lock.packages), ...object(trustedLock.packages) }
  packages[''] = { ...object(packages['']), name: current.name, dependencies: next.dependencies, devDependencies: next.devDependencies }
  return {
    packageContent: JSON.stringify(next, null, 2) + '\n',
    lockContent: JSON.stringify({ ...lock, lockfileVersion: 3, packages }, null, 2) + '\n',
  }
}
