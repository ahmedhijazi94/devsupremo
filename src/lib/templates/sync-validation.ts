import { TRUSTED_VALIDATION_POLICIES } from '../../../packages/cli/src/generated/validation-policy'

type JsonObject = Record<string, unknown>
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Manifesto de dependências inválido.')
  return value as JsonObject
}

/** Upgrade only platform-owned execution fields; preserve app dependencies. */
export function upgradeValidationPackages(currentPackage: string, currentLock: string, targetPackage: string, targetLock: string): { packageContent: string; lockContent: string } {
  const current = object(JSON.parse(currentPackage))
  const target = object(JSON.parse(targetPackage))
  const scripts = { ...object(current.scripts ?? {}) }
  const targetScripts = object(target.scripts)
  const managedScripts = new Set(TRUSTED_VALIDATION_POLICIES.flatMap(policy => Object.keys(policy.scripts)))
  for (const name of managedScripts) {
    scripts[name] = targetScripts[name]
    delete scripts[`pre${name}`]
    delete scripts[`post${name}`]
  }
  // Silently deleting user installation hooks/overrides could break the app.
  // Keep them visible in the PR; the independent gate requires explicit repair.
  const next: JsonObject = { ...current, scripts, dependencies: { ...object(current.dependencies ?? {}), ...object(target.dependencies) }, devDependencies: { ...object(current.devDependencies ?? {}), ...object(target.devDependencies) } }
  const lock = object(JSON.parse(currentLock))
  const trustedLock = object(JSON.parse(targetLock))
  const packages = { ...object(lock.packages), ...object(trustedLock.packages) }
  packages[''] = { ...object(packages['']), name: current.name, dependencies: next.dependencies, devDependencies: next.devDependencies }
  return {
    packageContent: JSON.stringify(next, null, 2) + '\n',
    lockContent: JSON.stringify({ ...lock, lockfileVersion: 3, packages }, null, 2) + '\n',
  }
}
