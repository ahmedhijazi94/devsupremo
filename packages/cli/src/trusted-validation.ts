import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TRUSTED_VALIDATION_POLICIES } from './generated/validation-policy'
import { blobHash, inspectValidationIntegrity, type PolicyTreeEntry } from './validation-integrity'

/** No network on the editing path. Server approval also verifies its own copy. */
export function verifyTrustedFiles(cwd: string): void {
  const tree: PolicyTreeEntry[] = []
  const paths = new Set(TRUSTED_VALIDATION_POLICIES.flatMap(p => Object.keys(p.files)))
  for (const path of ['package.json', 'package-lock.json', '.npmrc']) paths.add(path)
  try {
    for (const path of readdirSync(join(cwd, '.github/workflows'))) paths.add(`.github/workflows/${path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (const path of paths) {
    try {
      const full = join(cwd, path)
      // Reject parent symlinks too: trusted validators may never escape the tree.
      const segments = path.split('/')
      for (let i = 1; i <= segments.length; i++) if (lstatSync(join(cwd, ...segments.slice(0, i))).isSymbolicLink()) throw new Error(`Validador contém link simbólico: ${path}`)
      const stat = lstatSync(full)
      if (!stat.isFile()) continue
      tree.push({ path, sha: blobHash(readFileSync(full, 'utf8')), mode: stat.mode & 0o111 ? '100755' : '100644' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const pkg = readFileSync(join(cwd, 'package.json'), 'utf8')
  const lock = readFileSync(join(cwd, 'package-lock.json'), 'utf8')
  const results = TRUSTED_VALIDATION_POLICIES.map(manifest => inspectValidationIntegrity(manifest, tree, pkg, lock))
  if (results.some(result => result.length === 0)) return
  const closest = results.sort((a, b) => a.length - b.length)[0] ?? ['Política indisponível.']
  throw new Error(`A base de validação precisa ser atualizada pelo Supremo: ${closest.slice(0, 4).join('; ')}`)
}
