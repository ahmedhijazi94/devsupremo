/**
 * Regenera o package-lock.json pré-resolvido do template.
 *
 * Rode isto sempre que DEPENDENCIES ou DEV_DEPENDENCIES mudarem em
 * src/lib/templates/project-files.ts — o teste do manifesto reprova se o
 * lock ficar fora de sincronia.
 *
 *   npx tsx scripts/dev/regenerate-template-lock.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildProjectFiles } from '../../src/lib/templates/project-files'

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-lock-'))

try {
  const files = buildProjectFiles({
    projectName: 'supremo-template',
    description: 'resolução de dependências',
  })

  const pkg = files.find((f) => f.path === 'package.json')
  if (!pkg) throw new Error('package.json não está no manifesto.')

  for (const file of files.filter((f) => f.path === 'package.json' || f.path.startsWith('tools/supremo-cli/'))) {
    const target = path.join(workdir, file.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.content)
  }

  console.log('resolvendo dependências…')
  execFileSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], {
    cwd: workdir,
    stdio: 'inherit',
  })

  const destination = path.join(
    process.cwd(),
    'src/lib/templates/assets/package-lock.json'
  )
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(path.join(workdir, 'package-lock.json'), destination)

  const lock = JSON.parse(fs.readFileSync(destination, 'utf8')) as {
    packages: Record<string, unknown>
  }
  console.log(`lock atualizado: ${Object.keys(lock.packages).length} pacotes`)
} finally {
  fs.rmSync(workdir, { recursive: true, force: true })
}
