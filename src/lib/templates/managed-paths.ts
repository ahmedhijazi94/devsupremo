/**
 * Fonte única dos arquivos de base ("rails"): infraestrutura pura que o
 * Supremo gerencia, não conteúdo/feature do app. Tanto a atualização de base
 * quanto o Restore consomem esta lista: sync pode atualizá-los para o template
 * novo; Restore sempre preserva a versão que já está no workspace atual.
 *
 * O que NÃO está aqui é scaffold editável — página, migration, teste funcional
 * do app, documentação ou package.json. É onde funcionalidade, schema e
 * dependências do app vivem. O smoke E2E estrutural é rail: valida o contrato
 * de saúde da plataforma, nunca copy/feature.
 *
 * Migrations não entram aqui. Elas têm uma invariante diferente e mais forte:
 * `supabase/migrations/**` é forward-only e é preservado como diretório pelo
 * Restore, independentemente da propriedade do scaffold.
 */
export const PLATFORM_MANAGED_PATHS = [
  'tools/supremo-cli/package.json',
  'tools/supremo-cli/dist/bin.js',
  // Ferramentas e configuração
  'tsconfig.json',
  'next.config.ts',
  'eslint.config.mjs',
  'postcss.config.mjs',
  'vitest.config.ts',
  'vitest.setup.ts',
  'playwright.config.ts',
  'vercel.json',
  '.gitignore',
  '.nvmrc',
  // Infra da aplicação
  'lib/utils.ts',
  'components/preview-inspector.tsx',
  'proxy.ts',
  'lib/supabase/client.ts',
  'lib/supabase/server.ts',
  'app/auth/callback/route.ts',
  'app/auth/signout/route.ts',
  // Gates e segurança
  '.github/workflows/ci.yml',
  'e2e/smoke.spec.ts',
  'scripts/security-audit.js',
  // Local dev harness (base infra do Supremo)
  'scripts/verify.mjs',
  'scripts/supremo-status.mjs',
  'scripts/recovery-context.mjs',
  'scripts/setup-local.mjs',
  '.githooks/pre-commit',
  '.githooks/pre-push',
] as const

export const MANAGED_PATHS: ReadonlySet<string> = new Set(
  PLATFORM_MANAGED_PATHS,
)

/** Este arquivo é rail (o Supremo reescreve/preserva) ou conteúdo do app? */
export function isManagedPath(path: string): boolean {
  return MANAGED_PATHS.has(path)
}
