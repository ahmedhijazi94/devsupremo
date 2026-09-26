import { TRUSTED_VALIDATION_POLICIES_4_0_15_5_1_3 } from '../../../src/lib/github/validation-policy-releases/4.0.15-5.1.3'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TRUSTED_VALIDATION_POLICIES } from './generated/validation-policy'
import { TRUSTED_VALIDATION_POLICIES_4_0_5 } from '../../../src/lib/github/validation-policy-releases/4.0.5'
import { TRUSTED_VALIDATION_POLICIES_4_0_6 } from '../../../src/lib/github/validation-policy-releases/4.0.6'
import { TRUSTED_VALIDATION_POLICIES_4_0_7 } from '../../../src/lib/github/validation-policy-releases/4.0.7'
import { TRUSTED_VALIDATION_POLICIES_4_0_8 } from '../../../src/lib/github/validation-policy-releases/4.0.8'
import { TRUSTED_VALIDATION_POLICIES_4_0_9 } from '../../../src/lib/github/validation-policy-releases/4.0.9'
import { TRUSTED_VALIDATION_POLICIES_4_0_10_5_0_0 } from '../../../src/lib/github/validation-policy-releases/4.0.10-5.0.0'
import { TRUSTED_VALIDATION_POLICIES_4_0_11_5_0_1 } from '../../../src/lib/github/validation-policy-releases/4.0.11-5.0.1'
import { TRUSTED_VALIDATION_POLICIES_4_0_12_5_1_0 } from '../../../src/lib/github/validation-policy-releases/4.0.12-5.1.0'
import { TRUSTED_VALIDATION_POLICIES_4_0_13_5_1_1 } from '../../../src/lib/github/validation-policy-releases/4.0.13-5.1.1'
import { TRUSTED_VALIDATION_POLICIES_4_0_14_5_1_2 } from '../../../src/lib/github/validation-policy-releases/4.0.14-5.1.2'
import { blobHash, inspectValidationIntegrity, type PolicyTreeEntry } from './validation-integrity'
import { readStableFile } from './stable-file'

// Published project rails remain verifiable when only their engine is upgraded.
const localPolicies = [...TRUSTED_VALIDATION_POLICIES, ...TRUSTED_VALIDATION_POLICIES_4_0_15_5_1_3, ...TRUSTED_VALIDATION_POLICIES_4_0_14_5_1_2, ...TRUSTED_VALIDATION_POLICIES_4_0_13_5_1_1, ...TRUSTED_VALIDATION_POLICIES_4_0_12_5_1_0, ...TRUSTED_VALIDATION_POLICIES_4_0_11_5_0_1,
  ...TRUSTED_VALIDATION_POLICIES_4_0_10_5_0_0, ...TRUSTED_VALIDATION_POLICIES_4_0_9, ...TRUSTED_VALIDATION_POLICIES_4_0_8,
  ...TRUSTED_VALIDATION_POLICIES_4_0_7, ...TRUSTED_VALIDATION_POLICIES_4_0_6, ...TRUSTED_VALIDATION_POLICIES_4_0_5]

/** No network on the editing path. Server approval also verifies its own copy. */
export function verifyTrustedFiles(cwd: string): void {
  const tree: PolicyTreeEntry[] = []
  const contents = new Map<string, string>()
  const paths = new Set(localPolicies.flatMap(p => Object.keys(p.files)))
  for (const path of ['package.json', 'package-lock.json', '.npmrc']) paths.add(path)
  try {
    for (const path of readdirSync(join(cwd, '.github/workflows'))) paths.add(`.github/workflows/${path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (const path of paths) {
    try {
      const file = readStableFile(join(cwd, path), 16 * 1024 * 1024, cwd)
      contents.set(path, file.content)
      tree.push({ path, sha: blobHash(file.content), mode: file.mode & 0o111 ? '100755' : '100644' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const pkg = contents.get('package.json'), lock = contents.get('package-lock.json')
  if (pkg === undefined || lock === undefined) throw new Error('Package ou lockfile obrigatório ausente da base de validação.')
  const results = localPolicies.map(manifest => inspectValidationIntegrity(manifest, tree, pkg, lock))
  if (results.some(result => result.length === 0)) return
  const closest = results.sort((a, b) => a.length - b.length)[0] ?? ['Política indisponível.']
  throw new Error(`A base de validação precisa ser atualizada pelo Supremo: ${closest.slice(0, 4).join('; ')}`)
}
