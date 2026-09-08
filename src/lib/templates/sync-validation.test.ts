import { expect, it } from 'vitest'
import { buildProjectFiles } from './project-files'
import { upgradeValidationPackages } from './sync-validation'

it('upgrades validator commands and locked tools while preserving app dependencies and scripts', () => {
  const files = new Map(buildProjectFiles({ projectName: 'app', description: '' }).map(file => [file.path, file.content]))
  const targetPackage = files.get('package.json')!
  const targetLock = files.get('package-lock.json')!
  const current = JSON.parse(targetPackage)
  current.dependencies['my-feature'] = '1.0.0'
  current.scripts['generate:icons'] = 'node icons.mjs'
  current.scripts.test = 'echo fake-green'
  current.scripts.pretest = 'node rewrite-tests.mjs'
  const lock = JSON.parse(targetLock)
  lock.packages['node_modules/my-feature'] = { version: '1.0.0' }
  const result = upgradeValidationPackages(JSON.stringify(current), JSON.stringify(lock), targetPackage, targetLock)
  const pkg = JSON.parse(result.packageContent)
  expect(pkg.dependencies['my-feature']).toBe('1.0.0')
  expect(pkg.scripts['generate:icons']).toBe('node icons.mjs')
  expect(pkg.scripts.test).toBe(JSON.parse(targetPackage).scripts.test)
  expect(pkg.scripts.pretest).toBeUndefined()
  expect(JSON.parse(result.lockContent).packages['node_modules/my-feature']).toEqual({ version: '1.0.0' })
  expect(() => upgradeValidationPackages('[]', '{}', targetPackage, targetLock)).toThrow('inválido')
})
