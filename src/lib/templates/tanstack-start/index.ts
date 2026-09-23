import fs from 'node:fs'
import path from 'node:path'
import { withDevelopmentPolicy } from '../development-policy'
import { harnessPackageScripts } from '../harness'
import type { FileEntry, TemplateOptions } from '../project-files'
import { START_TEMPLATE_VERSION } from '../stacks'

export const TANSTACK_TEMPLATE_VERSION = START_TEMPLATE_VERSION
export const TANSTACK_STACK = 'tanstack-start-vite'

interface PackageManifest {
  name: string
  version: string
  private: boolean
  engines: Record<string, string>
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}
interface LockManifest { name: string; packages: Record<string, { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }> }

const assets = () => path.join(process.cwd(), 'src/lib/templates/tanstack-start/assets')
const encodedJs = (value: string) => JSON.stringify(value).slice(1, -1).replaceAll("'", "\\'")
const encodedJsx = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('{', '&#123;').replaceAll('}', '&#125;')
const authOnly = (name: string) => /^(src\/(features\/(auth|profile|organizations)\/|lib\/supabase\/|routes\/(app\.|login\.|auth\.)))/.test(name)

/** New-project adapter: preserve migrations and the validation rails; replace only framework files. */
export function adaptTanStackFiles(legacyFiles: readonly FileEntry[], options: TemplateOptions): FileEntry[] {
  const kind = options.kind ?? 'solo'
  const auth = kind !== 'public'
  const original = new Map(legacyFiles.map((file) => [file.path, file]))
  const result = new Map<string, FileEntry>()
  const put = (name: string, content: string, mode?: FileEntry['mode']) => result.set(name, { path: name, content, ...(mode ? { mode } : {}) })
  for (const file of legacyFiles) {
    if (file.path.startsWith('app/') || file.path === 'proxy.ts' || file.path === 'next.config.ts' || file.path.startsWith('lib/supabase/') || file.path === 'vitest.config.ts') continue
    if (file.path.startsWith('components/') || file.path.startsWith('lib/')) {
      let content = file.content.replace(/^["']use client["'];?\s*/m, '')
      if (file.path === 'components/app-shell.tsx') content = content.replace("import Link from 'next/link'\n", '').replaceAll('<Link ', '<a ').replaceAll('</Link>', '</a>')
      put(`src/${file.path}`, content, file.mode)
    } else put(file.path, file.content, file.mode)
  }
  const metadata = JSON.parse(original.get('.supremo/project.json')?.content ?? '{}') as Record<string, unknown>
  const supremoOrigin = typeof metadata.supremoUrl === 'string' ? new URL(metadata.supremoUrl).origin : 'https://supremo-three.vercel.app'
  for (const name of fs.readdirSync(assets(), { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.txt')).sort()) {
    const outputPath = name.slice(0, -4).split(path.sep).join('/')
    if ((!auth && authOnly(outputPath)) || (kind !== 'team' && outputPath.startsWith('src/features/organizations/'))) continue
    let content = fs.readFileSync(path.join(assets(), name), 'utf8')
      .replaceAll('__PROJECT_NAME_JSX__', encodedJsx(options.projectName))
      .replaceAll('__PROJECT_NAME_JS__', encodedJs(options.projectName))
      .replaceAll('__DESCRIPTION_JSX__', encodedJsx(options.description || 'Seu espaço para organizar o que importa.'))
      .replaceAll('__SUPREMO_ORIGIN__', encodedJs(supremoOrigin))
      .replaceAll('__AUTH_HOME_LINK__', auth ? '<Link to="/login" search={{ mode: \'signup\' }} className={buttonClass(\'primary\', \'lg\')}>Criar minha conta</Link><Link to="/login" className={buttonClass(\'ghost\', \'lg\')}>Já tenho uma conta</Link>' : '')
    if (!auth && outputPath === 'src/routes/index.tsx') content = content.replace('createFileRoute, Link', 'createFileRoute').replace("import { buttonClass } from '@/components/ui/button'\n", '')
    put(outputPath, content)
  }
  // Keep the established palette and append Start's semantic aliases. Assets
  // never load remote fonts or require weaker content-security headers.
  put('src/styles.css', (original.get('app/globals.css')?.content ?? '') + '\n' + (result.get('src/styles.css')?.content ?? ''))
  const examples = original.get('app/design-system/examples.tsx')
  if (examples) put('src/components/design-examples.tsx', examples.content.replace(/^["']use client["'];?\s*/m, ''))
  const legacyPackage = JSON.parse(original.get('package.json')?.content ?? '{}') as PackageManifest
  const manifest = JSON.parse(fs.readFileSync(path.join(assets(), '../package.json'), 'utf8')) as PackageManifest
  manifest.name = options.projectName
  manifest.scripts = {
    ...legacyPackage.scripts,
    ...harnessPackageScripts('tanstack-start-vite'),
    dev: 'vite --host 127.0.0.1 --strictPort',
    'dev:preview': 'vite --host 127.0.0.1 --strictPort',
    'routes:generate': 'node scripts/generate-routes.mjs',
    typecheck: 'npm run routes:generate && tsc --noEmit',
    build: 'vite build',
    start: 'node scripts/start-production.mjs',
  }
  put('package.json', `${JSON.stringify(manifest, null, 2)}\n`)
  const lock = JSON.parse(fs.readFileSync(path.join(assets(), '../package-lock.json'), 'utf8')) as LockManifest
  lock.name = options.projectName
  const lockRoot = lock.packages['']
  if (!lockRoot) throw new Error('Start template lockfile is missing its root package')
  lockRoot.name = options.projectName
  put('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`)
  put('.supremo/project.json', `${JSON.stringify({ ...metadata, stack: TANSTACK_STACK, scaffoldVersion: TANSTACK_TEMPLATE_VERSION }, null, 2)}\n`)
  put('.gitignore', `${original.get('.gitignore')?.content ?? ''}\n.tanstack/\n.output/\nsrc/routeTree.gen.ts\n`)
  put('.nvmrc', '22\n')
  put('.env.example', '# Only these public values enter the browser.\nVITE_SUPABASE_URL=https://your-project.supabase.co\nVITE_SUPABASE_ANON_KEY=your-publishable-or-anon-key\n\n# Private values must never have a VITE_ prefix. Ordinary application access uses the user session.\n')
  put('vercel.json', `${JSON.stringify({ $schema: 'https://openapi.vercel.sh/vercel.json', framework: 'tanstack-start', github: { silent: true } }, null, 2)}\n`)
  put('scripts/security-audit.js', fs.readFileSync(path.join(process.cwd(), 'scripts/security-audit.js'), 'utf8'), '100755')
  const ci = original.get('.github/workflows/ci.yml')?.content ?? ''
  put('.github/workflows/ci.yml', ci.replaceAll('NEXT_PUBLIC_SUPABASE_URL', 'VITE_SUPABASE_URL').replaceAll('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY'))
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const entry = result.get(name)
    if (entry) put(name, withDevelopmentPolicy(entry.content))
  }
  const workflow = original.get('.supremo/DEVELOPMENT.md')?.content ?? ''
  put('.supremo/DEVELOPMENT.md', workflow.replaceAll('process.env no Next local', 'process.env no servidor local').replaceAll('NEXT_PUBLIC_', 'VITE_'))
  const anonymous = original.get('lib/supabase/anonymous.ts')
  if (anonymous) put('src/lib/supabase/anonymous.ts', anonymous.content.replaceAll('process.env.NEXT_PUBLIC_SUPABASE_URL', 'import.meta.env.VITE_SUPABASE_URL').replaceAll('process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY', 'import.meta.env.VITE_SUPABASE_ANON_KEY'))
  const security = original.get('SECURITY.md')?.content ?? ''
  put('SECURITY.md', security.replaceAll('`proxy.ts`', '`src/start.ts`').replaceAll('`next.config.ts`', '`src/lib/security/headers.ts`'))
  return [...result.values()]
}
