import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TRUSTED_VALIDATION_POLICIES } from './generated/validation-policy'
import { blobHash, inspectValidationIntegrity, type PolicyTreeEntry } from './validation-integrity'
import { readStableFile } from './stable-file'

/** No network on the editing path. Server approval also verifies its own copy. */
export function verifyTrustedFiles(cwd: string): void {
  const tree: PolicyTreeEntry[] = []
  const contents = new Map<string, string>()
  const paths = new Set(TRUSTED_VALIDATION_POLICIES.flatMap(p => Object.keys(p.files)))
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
  const results = TRUSTED_VALIDATION_POLICIES.map(manifest => inspectValidationIntegrity(manifest, tree, pkg, lock))
  if (results.some(result => result.length === 0)) return
  const closest = results.sort((a, b) => a.length - b.length)[0] ?? ['Política indisponível.']
  throw new Error(`A base de validação precisa ser atualizada pelo Supremo: ${closest.slice(0, 4).join('; ')}`)
}
