import fs from 'node:fs'
import path from 'node:path'
import { generateRlsTest, inferTablesFromMigration } from './rls-tests'

/**
 * Manifesto de arquivos de um projeto novo.
 *
 * A versão anterior gerava um projeto que não compilava: o CI rodava
 * `npm run test` e `npm run test:e2e`, que não existiam no package.json, e o
 * job de build declarava `needs` nesses jobs. Todo projeto nascia com o CI
 * vermelho e nunca fazia deploy.
 *
 * A regra aqui é uma só: o que este manifesto produz precisa passar em
 * `npm ci && npm run typecheck && npm run lint && npm test && npm run build`.
 * O teste em `project-files.test.ts` verifica a coerência entre os scripts
 * declarados, as dependências instaladas e os jobs do CI.
 */

export const TEMPLATE_VERSION = '2.0.0'

export interface FileEntry {
  path: string
  content: string
  mode?: '100644' | '100755'
}

export interface TemplateOptions {
  projectName: string
  description: string
  /**
   * O app tem usuários e login?
   *
   * Ligado (padrão): nasce com fluxo de login pronto, uma rota protegida de
   * exemplo, e as tabelas de usuário com RLS. É o caso central do Supremo —
   * app com dados de gente.
   *
   * Desligado: app público. Sem login, sem tabela de usuário, sem código de
   * auth morto. É a resposta honesta para "meu app não precisa de login":
   * forçar RLS em auth.uid() sem login trava tudo fechado, então o app
   * público simplesmente não recebe essa camada.
   */
  auth?: boolean
}

// ─────────────────────────────────────────────────────────────
// Dependências e scripts — fonte única
// ─────────────────────────────────────────────────────────────

const DEPENDENCIES = {
  '@supabase/ssr': '^0.12.5',
  '@supabase/supabase-js': '^2.112.4',
  'class-variance-authority': '^0.7.1',
  clsx: '^2.1.1',
  'lucide-react': '^1.35.0',
  next: '16.3.3',
  react: '19.2.8',
  'react-dom': '19.2.8',
  'tailwind-merge': '^3.6.0',
  zod: '^4.5.2',
} as const

const DEV_DEPENDENCIES = {
  '@playwright/test': '^1.62.1',
  '@tailwindcss/postcss': '^4.3.3',
  '@testing-library/dom': '^10.4.1',
  '@testing-library/jest-dom': '^7.0.1',
  '@testing-library/react': '^16.3.3',
  '@types/node': '^20.19.43',
  '@types/react': '^19.2.18',
  '@types/react-dom': '^19.2.5',
  '@vitejs/plugin-react': '^6.1.1',
  '@vitest/coverage-v8': '^3.2.7',
  eslint: '^9.39.5',
  'eslint-config-next': '16.3.3',
  jsdom: '^25.0.1',
  tailwindcss: '^4.3.3',
  typescript: '^5.9.3',
  vitest: '^3.2.7',
} as const

const SCRIPTS = {
  dev: 'next dev',
  // O preview do Supremo roda dentro de um WebContainer, onde binário
  // nativo não executa — e o Turbopack, padrão do Next 16, é nativo.
  // Webpack roda em WASM e é o que funciona lá.
  'dev:preview': 'next dev --webpack',
  build: 'next build',
  start: 'next start',
  lint: 'eslint',
  typecheck: 'tsc --noEmit',
  test: 'vitest run --exclude "**/*.rls.test.ts"',
  'test:watch': 'vitest',
  'test:coverage': 'vitest run --coverage --exclude "**/*.rls.test.ts"',
  'test:rls': 'vitest run rls.test',
  'test:e2e': 'playwright test',
  'audit:security': 'node scripts/security-audit.js',
} as const

/**
 * Nome de cada job do CI, na grafia exata que o GitHub usa como nome do check.
 *
 * Fonte única de propósito: a proteção de branch exige checks POR NOME, e a
 * lista dela vivia escrita à mão em outro arquivo. As duas divergiram — o CI
 * rodava sete gates e o merge exigia três. Isolamento entre contas, varredura
 * de segredos, vulnerabilidades e end-to-end rodavam, ficavam vermelhos, e o
 * botão de merge continuava verde. Quem acrescentar um job aqui torna ele
 * obrigatório no mesmo movimento.
 */
export const CI_JOB_NAMES = [
  'Tipos, lint e auditoria',
  'Testes e cobertura',
  'Políticas RLS',
  'Vulnerabilidades',
  'Varredura de segredos',
  'Build de produção',
  'End-to-end',
] as const

/** Scripts que o CI invoca. O teste do manifesto confere que todos existem. */
export const CI_INVOKED_SCRIPTS = [
  'audit:security',
  'typecheck',
  'lint',
  'test:coverage',
  'test:rls',
  'test:e2e',
  'build',
] as const

// ─────────────────────────────────────────────────────────────

export function buildProjectFiles(options: TemplateOptions): FileEntry[] {
  const { projectName, description } = options
  const summary = description || `${projectName} — criado com Supremo`
  const auth = options.auth ?? true

  // A migration muda com a decisão de auth: com login, as tabelas de usuário
  // (profiles/audit_logs); sem login, um exemplo público, para o app não
  // nascer com tabela morta que só funciona autenticado.
  const migration = auth ? initialMigration() : publicMigration()

  const files: FileEntry[] = [
    // ── Manifesto e configuração ──────────────────────────────
    { path: 'package.json', content: packageJson(projectName) },
    { path: 'package-lock.json', content: packageLock(projectName) },
    { path: 'tsconfig.json', content: tsconfig() },
    { path: 'next.config.ts', content: nextConfig() },
    { path: 'eslint.config.mjs', content: eslintConfig() },
    { path: 'postcss.config.mjs', content: postcssConfig() },
    { path: 'vitest.config.ts', content: vitestConfig() },
    { path: 'vitest.setup.ts', content: vitestSetup() },
    { path: 'playwright.config.ts', content: playwrightConfig() },
    { path: 'vercel.json', content: vercelJson() },
    { path: '.gitignore', content: gitignore() },
    { path: '.env.example', content: envExample() },
    { path: '.nvmrc', content: '20\n' },

    // ── Aplicação ─────────────────────────────────────────────
    { path: 'app/layout.tsx', content: appLayout(projectName, summary) },
    { path: 'app/page.tsx', content: appPage(projectName, summary, auth) },
    { path: 'app/globals.css', content: globalsCss() },
    { path: 'lib/utils.ts', content: libUtils() },
    // O proxy sempre existe pelo nonce da CSP. Com login, ele também renova
    // a sessão a cada requisição.
    { path: 'proxy.ts', content: proxyFile(auth) },

    // ── Banco ─────────────────────────────────────────────────
    { path: 'supabase/config.toml', content: supabaseConfig(projectName) },
    {
      path: 'supabase/migrations/00000000000000_initial_schema.sql',
      content: migration,
    },

    // ── Testes ────────────────────────────────────────────────
    { path: 'lib/utils.test.ts', content: utilsTest() },
    { path: 'app/page.test.tsx', content: pageTest(projectName) },
    {
      path: 'supabase/rls.rls.test.ts',
      // Derivado da migration que acabou de ser escrita, nunca de uma lista à
      // mão. A lista à mão cobria só `profiles`, e `audit_logs` — a trilha de
      // auditoria, onde uma policy furada é mais cara — nascia sem uma única
      // asserção provando o isolamento. O gate ficava verde por não olhar.
      content: generateRlsTest(inferTablesFromMigration(migration)),
    },
    { path: 'e2e/smoke.spec.ts', content: e2eSmoke(projectName, auth) },

    // ── Gates ─────────────────────────────────────────────────
    { path: '.github/workflows/ci.yml', content: ciWorkflow(projectName) },
    { path: '.github/dependabot.yml', content: dependabotConfig() },
    {
      path: 'scripts/security-audit.js',
      content: securityAuditScript(),
      mode: '100755',
    },

    // ── Documentação e regras ─────────────────────────────────
    { path: 'README.md', content: readme(projectName, summary) },
    { path: 'agents.md', content: agentsMd(projectName, summary) },
    { path: 'CLAUDE.md', content: claudeMd(projectName) },
    { path: 'SECURITY.md', content: securityMd(projectName) },
  ]

  if (auth) {
    // O cliente de navegador e o servidor só fazem sentido com login. App
    // público não os carrega para não haver caminho de dado autenticado morto.
    files.push(
      { path: 'lib/supabase/client.ts', content: supabaseClient() },
      { path: 'lib/supabase/server.ts', content: supabaseServer() },
      { path: 'app/login/page.tsx', content: loginPage(projectName) },
      { path: 'app/login/login-form.tsx', content: loginForm() },
      { path: 'app/auth/callback/route.ts', content: authCallbackRoute() },
      { path: 'app/auth/signout/route.ts', content: signoutRoute() },
      { path: 'app/app/page.tsx', content: protectedPage(projectName) },
    )
  }

  return files
}

// ═════════════════════════════════════════════════════════════
// Configuração
// ═════════════════════════════════════════════════════════════

function packageJson(projectName: string): string {
  return `${JSON.stringify(
    {
      name: projectName,
      version: '0.1.0',
      private: true,
      engines: { node: '>=20' },
      scripts: SCRIPTS,
      dependencies: DEPENDENCIES,
      devDependencies: DEV_DEPENDENCIES,
    },
    null,
    2,
  )}\n`
}

function tsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['dom', 'dom.iterable', 'esnext'],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noUncheckedIndexedAccess: true,
        noImplicitReturns: true,
        noFallthroughCasesInSwitch: true,
        noEmit: true,
        esModuleInterop: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: 'react-jsx',
        incremental: true,
        plugins: [{ name: 'next' }],
        paths: { '@/*': ['./*'] },
      },
      include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
      exclude: ['node_modules', 'vitest.config.ts', 'playwright.config.ts'],
    },
    null,
    2,
  )}\n`
}

/**
 * CSP incluída de verdade.
 *
 * O SECURITY.md do template anterior afirmava que a CSP estava configurada
 * em next.config.ts — arquivo que o scaffold nunca gerava.
 */
/**
 * Origem do painel do Supremo, embutida no app gerado.
 *
 * É o único site autorizado a enquadrar a aplicação. Sem um valor confiável
 * aqui a alternativa seria liberar para todo mundo, que era o problema.
 */
function supremoOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  return 'https://supremo-three.vercel.app'
}

function nextConfig(): string {
  return `import type { NextConfig } from 'next'

const isDev = process.env.NODE_ENV === 'development'

/**
 * O preview do Supremo abre a aplicação dentro de um iframe.
 *
 * Em produção o enquadramento fica bloqueado — é a defesa contra
 * clickjacking, alguém colocar seu site dentro do dele para enganar o
 * usuário. Em desenvolvimento e em preview deploy isso é liberado, senão o
 * preview mostra uma tela em branco.
 */
const isFramable =
  isDev ||
  process.env.VERCEL_ENV === 'preview' ||
  // O Supremo publica o preview como deploy próprio, e a Vercel pode
  // rotulá-lo como produção. Este sinal explícito não depende do rótulo.
  process.env.SUPREMO_PREVIEW === '1'

/**
 * A Content-Security-Policy NÃO mora aqui.
 *
 * Ela precisa de um nonce diferente a cada requisição, e cabeçalho declarado
 * em next.config é estático. A política inteira está em proxy.ts, na raiz.
 * Duas CSPs no mesmo response se somam pela regra mais restritiva e viram
 * bloqueio difícil de diagnosticar — por isso aqui não há nenhuma.
 */

const securityHeaders = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  // Omitido quando enquadrável: o header não tem valor que signifique
  // "permita", e mantê-lo anularia o frame-ancestors da CSP.
  ...(isFramable ? [] : [{ key: 'X-Frame-Options', value: 'DENY' }]),
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
]

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }]
  },
}

export default nextConfig
`
}

function eslintConfig(): string {
  return `import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'coverage/**',
    'playwright-report/**',
    'next-env.d.ts',
  ]),
  {
    files: ['scripts/**/*.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
])
`
}

function postcssConfig(): string {
  return `const config = {
  plugins: ['@tailwindcss/postcss'],
}

export default config
`
}

function vitestConfig(): string {
  return `import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  // Runtime automático de JSX, alinhado ao jsx: "react-jsx" do tsconfig.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@': path.resolve(__dirname, './') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules/**', 'e2e/**', '.next/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['lib/**/*.ts', 'app/**/*.tsx'],
      exclude: [
        '**/*.test.*',
        '**/*.d.ts',
        // Fábricas finas sobre o SDK do Supabase: um teste unitário aqui
        // exercitaria o mock, não o código. A cobertura real delas vem do
        // E2E e dos testes de RLS.
        'lib/supabase/**',
        // Shell da aplicação, sem lógica própria.
        'app/layout.tsx',
        // Telas de login e a rota protegida falam com o Supabase e são
        // cobertas pelo E2E — um teste unitário aqui exercitaria o mock.
        'app/login/**',
        'app/app/**',
        'app/auth/**',
      ],
      // Threshold que FALHA o build. Cobertura reportada e não exigida
      // não é gate — é decoração. Se este número incomodar, escreva o
      // teste; não baixe o número.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
})
`
}

function vitestSetup(): string {
  return `import '@testing-library/jest-dom/vitest'
`
}

function playwrightConfig(): string {
  return `import { defineConfig, devices } from '@playwright/test'

/**
 * Porta dedicada ao E2E.
 *
 * A 3000 é a porta padrão de todo app Next; com reuseExistingServer, um outro
 * projeto rodando na máquina faz a suíte testar o app errado e falhar com
 * mensagens sem sentido. Uma porta própria elimina a colisão.
 */
const E2E_PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3100)
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL ?? \`http://localhost:\${E2E_PORT}\`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  // Ao adicionar um projeto aqui, instale o motor correspondente no CI
  // (.github/workflows/ci.yml). iPhone roda em WebKit, não em Chromium.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 14'] } }, // WebKit
  ],
  // Sem webServer quando aponta para um preview deploy já publicado.
  ...(process.env.PLAYWRIGHT_BASE_URL
    ? {}
    : {
        webServer: {
          command: \`npm run build && npm run start -- --port \${E2E_PORT}\`,
          url: baseURL,
          // Nunca reutilizar: garante que a suíte testa este projeto, e não
          // qualquer coisa que já esteja escutando na porta.
          reuseExistingServer: false,
          timeout: 180_000,
        },
      }),
})
`
}

function vercelJson(): string {
  return `${JSON.stringify(
    {
      $schema: 'https://openapi.vercel.sh/vercel.json',
      framework: 'nextjs',
      github: { silent: true },
    },
    null,
    2,
  )}\n`
}

function gitignore(): string {
  return `node_modules/
.next/
out/
build/
dist/
coverage/
playwright-report/
test-results/

.env*
!.env.example

*.log
.DS_Store
*.tsbuildinfo
next-env.d.ts
.vercel
docs/security-audit/last-audit.json
`
}

function envExample(): string {
  return `# Supabase — chaves públicas, seguras no cliente
NEXT_PUBLIC_SUPABASE_URL=https://seu-projeto.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sua-anon-key

# Somente servidor. NUNCA prefixe com NEXT_PUBLIC_.
SUPABASE_SERVICE_ROLE_KEY=sua-service-role-key

NEXT_PUBLIC_APP_URL=http://localhost:3000
`
}

// ═════════════════════════════════════════════════════════════
// Aplicação
// ═════════════════════════════════════════════════════════════

function appLayout(projectName: string, description: string): string {
  return `import type { Metadata } from 'next'
import { headers } from 'next/headers'
import './globals.css'

export const metadata: Metadata = {
  title: '${escapeJs(projectName)}',
  description: '${escapeJs(description)}',
}

/**
 * Ler o nonce aqui não é decoração: é o que faz a CSP funcionar.
 *
 * O nonce muda a cada requisição, então uma página pré-renderizada no build
 * não tem como carregá-lo — o HTML estático sai sem nonce nenhum, e a CSP
 * bloqueia todo script do Next. O sintoma é cruel: a página APARECE (o HTML
 * é servido) e simplesmente não responde a nada, porque não hidratou.
 *
 * Chamar headers() marca a árvore como dinâmica, e é a partir daí que o Next
 * assina os próprios scripts com o nonce. O custo é render por requisição —
 * que é o que uma aplicação com login faz de qualquer forma, já que ela lê
 * cookie. Se algum dia existir aqui uma página realmente estática e pública,
 * ela deve ficar fora deste layout.
 */
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  await headers()

  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  )
}
`
}

function appPage(
  projectName: string,
  description: string,
  auth: boolean,
): string {
  const loginLink = auth
    ? `
        <div>
          <a
            href="/login"
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
          >
            Entrar
          </a>
        </div>
`
    : ''

  return `import Link from 'next/link'

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-6 py-16">
      <div className="space-y-6">
        <span className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted">
          <span className="size-1.5 rounded-full bg-accent" />
          Criado com Supremo
        </span>

        <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
          ${escapeJsx(projectName)}
        </h1>

        <p className="max-w-prose text-lg text-muted">
          ${escapeJsx(description)}
        </p>
${loginLink}
        <div className="grid gap-3 pt-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border p-4">
            <h2 className="text-sm font-medium">RLS ativo</h2>
            <p className="mt-1 text-sm text-muted">
              Toda tabela nasce com Row Level Security e um teste que prova o
              isolamento entre contas.
            </p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <h2 className="text-sm font-medium">Gates no CI</h2>
            <p className="mt-1 text-sm text-muted">
              Tipos, lint, testes, cobertura, auditoria de segurança e E2E
              antes de qualquer merge.
            </p>
          </div>
        </div>
      </div>
    </main>
  )
}

// Link é usado só quando há login; a importação fica válida nos dois casos.
void Link

`
}

function globalsCss(): string {
  return `@import "tailwindcss";

@theme {
  --color-background: oklch(99% 0.002 265);
  --color-foreground: oklch(21% 0.015 265);
  --color-muted: oklch(52% 0.018 265);
  --color-border: oklch(91% 0.006 265);
  --color-accent: oklch(58% 0.19 275);
  --color-accent-foreground: oklch(99% 0 0);

  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, monospace;
}

@media (prefers-color-scheme: dark) {
  @theme {
    --color-background: oklch(16% 0.012 265);
    --color-foreground: oklch(95% 0.006 265);
    --color-muted: oklch(68% 0.016 265);
    --color-border: oklch(28% 0.012 265);
    --color-accent: oklch(70% 0.16 275);
    --color-accent-foreground: oklch(16% 0.012 265);
  }
}

@layer base {
  * {
    border-color: var(--color-border);
  }

  :focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
}
`
}

/**
 * Proxy do Next 16 — antigo middleware.
 *
 * Existe por um motivo só: a CSP precisa de um nonce por requisição.
 *
 * Sem ele a política de scripts era `'self' 'unsafe-inline'`, e o comentário
 * ao lado dizia que em produção o script ficava restrito à própria origem.
 * Não ficava: `'unsafe-inline'` autoriza qualquer script escrito na página,
 * que é exatamente o que um XSS injeta. A CSP existia e não defendia do que
 * ela existe para defender.
// ═════════════════════════════════════════════════════════════
// Login — só quando o app tem usuários
// ═════════════════════════════════════════════════════════════

/** A página de login: uma casca server que monta o formulário client. */
function loginPage(projectName: string): string {
  return `import { LoginForm } from './login-form'

export const metadata = { title: 'Entrar — ${escapeJs(projectName)}' }

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Entrar</h1>
      <p className="mt-1 mb-6 text-sm text-muted">
        Acesse a sua conta ou crie uma nova.
      </p>
      <LoginForm />
    </main>
  )
}
`
}

/**
 * Formulário de login por email e senha.
 *
 * Email + senha porque funciona sem configurar OAuth: o Supabase já vem com
 * esse provedor ligado. Para adicionar GitHub/Google depois, use
 * supabase.auth.signInWithOAuth e a rota /auth/callback já existe para o
 * retorno.
 */
function loginForm(): string {
  return `'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export function LoginForm() {
  const router = useRouter()
  const supabase = createClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)

    const fn =
      mode === 'signin'
        ? supabase.auth.signInWithPassword({ email, password })
        : supabase.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: \`\${location.origin}/auth/callback\` },
          })

    const { error } = await fn
    setBusy(false)

    if (error) {
      setError(error.message)
      return
    }
    // Server Component decide o acesso; aqui só levamos para a área logada.
    router.push('/app')
    router.refresh()
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1">
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="password" className="text-sm font-medium">
          Senha
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? '...' : mode === 'signin' ? 'Entrar' : 'Criar conta'}
      </button>

      <button
        type="button"
        onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
        className="w-full text-center text-sm text-muted hover:text-foreground"
      >
        {mode === 'signin'
          ? 'Não tem conta? Criar uma'
          : 'Já tem conta? Entrar'}
      </button>
    </form>
  )
}
`
}

/**
 * Retorno do OAuth e da confirmação de email: troca o código por sessão.
 *
 * Existe mesmo com login por senha, porque o link de confirmação de email
 * cai aqui. Adicionar um provedor OAuth depois não pede rota nova.
 */
function authCallbackRoute(): string {
  return `import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')

  if (code) {
    const supabase = await createClient()
    await supabase.auth.exchangeCodeForSession(code)
  }

  return NextResponse.redirect(\`\${origin}/app\`)
}
`
}

/** Sair: encerra a sessão e volta para o login. */
function signoutRoute(): string {
  return `import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: Request) {
  const supabase = await createClient()
  await supabase.auth.signOut()
  return NextResponse.redirect(new URL('/login', request.url), { status: 303 })
}
`
}

/**
 * Rota protegida de exemplo.
 *
 * É aqui que o acesso é decidido — no servidor, com getUser(). O proxy só
 * renova o token; ele NÃO barra ninguém. Sem usuário, redireciona ao login.
 * Também garante a linha de profile do usuário, respeitando o próprio RLS.
 */
function protectedPage(projectName: string): string {
  return `import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export default async function AppPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // O gate real de acesso. O proxy renova a sessão, mas quem decide é isto.
  if (!user) redirect('/login')

  // Garante o profile do próprio usuário. O RLS permite porque user_id é o
  // dono — a mesma policy que impede mexer no profile alheio.
  await supabase
    .from('profiles')
    .upsert(
      { user_id: user.id, display_name: user.email ?? 'sem nome' },
      { onConflict: 'user_id' },
    )

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <div>
        <p className="text-sm text-muted">Área logada de ${escapeJsx(projectName)}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Olá, {user.email}
        </h1>
      </div>

      <p className="max-w-prose text-muted">
        Esta rota só abre autenticado. Cada dado que você guardar fica isolado
        pela sua conta — o RLS garante que ninguém mais leia a sua linha.
      </p>

      <form action="/auth/signout" method="post">
        <button
          type="submit"
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-foreground/5"
        >
          Sair
        </button>
      </form>
    </main>
  )
}
`
}

/**
 * Migration de app público: sem tabela de usuário.
 *
 * A resposta honesta a "não preciso de login": RLS por auth.uid() sem login
 * tranca tudo fechado, então um app público não recebe essa camada. Ele nasce
 * limpo, e as tabelas que precisar vêm depois, com a posse que fizer sentido.
 */
function publicMigration(): string {
  return `-- ============================================================
-- Migration inicial — app público (sem login)
-- criada pelo Supremo
-- ============================================================
--
-- Este app não tem usuários. Não há tabela com RLS por auth.uid() porque,
-- sem login, auth.uid() é sempre nulo e isso trancaria tudo fechado.
--
-- Quando precisar guardar dado, crie a tabela com a posse certa:
--   - dado público de leitura: FOR SELECT USING (true)
--   - dado por usuário: adicione login e user_id (veja o SECURITY.md)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Utilitário de updated_at, pronto para quando a primeira tabela chegar.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;
`
}

// ═════════════════════════════════════════════════════════════
// Proxy
// ═════════════════════════════════════════════════════════════

/**
 * O nonce só pode ser gerado por requisição, e cabeçalho de next.config é
 * estático — por isso a CSP mudou de lugar. `strict-dynamic` faz o navegador
 * confiar apenas no que veio com o nonce, e ignorar lista de origens.
 */
function proxyFile(auth: boolean): string {
  // O import e a renovação de sessão só entram quando há login. App público
  // não carrega o cliente Supabase no proxy.
  const authImport = auth
    ? `import { createServerClient } from '@supabase/ssr'\n`
    : ''

  const renew = auth
    ? `
  // Renova a sessão a cada requisição, mantendo o token válido. Sem isto, o
  // usuário é deslogado quando o access token expira. NÃO decide acesso a
  // rota — quem decide é o Server Component chamando supabase.auth.getUser().
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (supabaseUrl && supabaseKey) {
    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          )
        },
      },
    })
    await supabase.auth.getUser()
  }
`
    : ''

  const signature = auth
    ? 'export async function proxy(request: NextRequest) {'
    : 'export function proxy(request: NextRequest) {'

  return `${authImport}import { NextResponse, type NextRequest } from 'next/server'

const isDev = process.env.NODE_ENV === 'development'

const SUPREMO_ORIGIN = '${supremoOrigin()}'

const isFramable =
  isDev ||
  process.env.VERCEL_ENV === 'preview' ||
  process.env.SUPREMO_PREVIEW === '1'

${signature}
  // 128 bits de aleatoriedade por requisição. Nonce previsível não é nonce.
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')

  const csp = [
    "default-src 'self'",
    // 'strict-dynamic' faz o navegador ignorar a lista de origens e confiar
    // só no que carregar com este nonce. 'unsafe-inline' fica na política
    // apenas como plano B para navegador antigo: onde 'strict-dynamic' é
    // entendido, ele anula o 'unsafe-inline'.
    \`script-src 'self' 'nonce-\${nonce}' 'strict-dynamic' 'unsafe-inline'\${
      isDev ? " 'unsafe-eval'" : ''
    }\`,
    // Estilo continua com 'unsafe-inline': o Next injeta CSS na página e não
    // aplica nonce a ele. Estilo inline não executa código.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.supabase.co https://avatars.githubusercontent.com",
    "font-src 'self' data:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    isFramable
      ? \`frame-ancestors 'self' \${isDev ? 'http://localhost:*' : SUPREMO_ORIGIN}\`
      : "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ')

  // O Next lê o nonce do cabeçalho da REQUISIÇÃO e o aplica nos próprios
  // scripts. Sem repassar aqui, a página carregaria sem nonce e a política
  // bloquearia o hidrate.
  const headers = new Headers(request.headers)
  headers.set('x-nonce', nonce)
  headers.set('Content-Security-Policy', csp)

  const response = NextResponse.next({ request: { headers } })
  response.headers.set('Content-Security-Policy', csp)
${renew}
  return response
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
`
}

function libUtils(): string {
  return `import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Junta classes do Tailwind resolvendo conflitos do último para o primeiro. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** Formata data em pt-BR de forma estável entre servidor e cliente. */
export function formatDate(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}
`
}

function supabaseClient(): string {
  return `import { createBrowserClient } from '@supabase/ssr'

/**
 * Cliente do navegador. Usa apenas a anon key — o RLS é quem decide o que
 * este cliente enxerga.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !key) {
    throw new Error(
      'Supabase não configurado. Preencha NEXT_PUBLIC_SUPABASE_URL e ' +
        'NEXT_PUBLIC_SUPABASE_ANON_KEY no .env.local — os valores estão em ' +
        'Project Settings > API no painel do Supabase.'
    )
  }

  return createBrowserClient(url, key)
}
`
}

function supabaseServer(): string {
  return `import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  // O cliente de navegador já explicava a ausência; aqui havia \`!\`, que troca
  // a explicação por um erro opaco no meio do render do servidor.
  if (!url || !key) {
    throw new Error(
      'Supabase não configurado no servidor. Defina NEXT_PUBLIC_SUPABASE_URL e ' +
        'NEXT_PUBLIC_SUPABASE_ANON_KEY no ambiente — em produção, nas variáveis ' +
        'do projeto na Vercel.'
    )
  }

  return createServerClient(
    url,
    key,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Chamado de Server Component — o middleware cuida dos cookies.
          }
        },
      },
    }
  )
}
`
}

// ═════════════════════════════════════════════════════════════
// Banco
// ═════════════════════════════════════════════════════════════

function supabaseConfig(projectName: string): string {
  return `project_id = "${projectName}"

[api]
enabled = true
port = 54321
schemas = ["public", "storage", "graphql_public"]
max_rows = 1000

[db]
port = 54322
major_version = 15

[auth]
enabled = true
site_url = "http://localhost:3000"
enable_signup = true

[auth.email]
enable_signup = true
enable_confirmations = false
`
}

/**
 * Migration inicial versionada no repositório.
 *
 * O template anterior aplicava o SQL direto pela API e não versionava nada,
 * contrariando a própria regra que escrevia no agents.md.
 */
function initialMigration(): string {
  return `-- ============================================================
-- Migration inicial — criada pelo Supremo
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------
-- updated_at automático
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
-- search_path fixo: sem isto a função resolve nomes pelo caminho de quem a
-- chama, e um schema plantado na frente do public muda o que ela executa.
-- É o mesmo aviso que o linter do Supabase dá como function_search_path_mutable.
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- PROFILES
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles(user_id);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_select_own" ON profiles
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "profiles_insert_own" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "profiles_update_own" ON profiles
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "profiles_delete_own" ON profiles
  FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------------
-- AUDIT LOGS
-- Somente leitura do próprio registro e inserção em nome próprio.
-- WITH CHECK (true) permitiria forjar registro de auditoria alheio.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON audit_logs(created_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_logs_select_own" ON audit_logs
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "audit_logs_insert_own" ON audit_logs
  FOR INSERT WITH CHECK (auth.uid() = user_id);
`
}

// ═════════════════════════════════════════════════════════════
// Testes
// ═════════════════════════════════════════════════════════════

function utilsTest(): string {
  return `import { describe, it, expect } from 'vitest'
import { cn, formatDate } from './utils'

describe('cn', () => {
  it('junta classes', () => {
    expect(cn('px-2', 'py-1')).toBe('px-2 py-1')
  })

  it('resolve conflito do Tailwind mantendo a última', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4')
  })

  it('ignora valores falsos', () => {
    expect(cn('px-2', false, null, undefined, 'py-1')).toBe('px-2 py-1')
  })

  it('aceita condicional em objeto', () => {
    expect(cn({ 'text-red-500': true, 'text-blue-500': false })).toBe(
      'text-red-500'
    )
  })
})

describe('formatDate', () => {
  it('formata ISO em pt-BR', () => {
    expect(formatDate('2026-03-09T00:00:00Z')).toBe('09/03/2026')
  })

  it('aceita objeto Date', () => {
    expect(formatDate(new Date('2026-12-25T00:00:00Z'))).toBe('25/12/2026')
  })
})
`
}

function pageTest(projectName: string): string {
  return `import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import HomePage from './page'

describe('HomePage', () => {
  it('mostra o nome do projeto como título principal', () => {
    render(<HomePage />)
    expect(
      screen.getByRole('heading', { level: 1, name: '${escapeJs(projectName)}' })
    ).toBeInTheDocument()
  })

  it('tem um único h1 — hierarquia correta para leitores de tela', () => {
    render(<HomePage />)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })
})
`
}

/**
 * Smoke E2E que passa de verdade.
 *
 * O template anterior gerava um teste que checava o título "Create Next App"
 * contra um layout sem título nenhum — falha garantida.
 */
function e2eSmoke(projectName: string, auth: boolean): string {
  // Com login, o E2E exercita a tela de /login e o gate da rota protegida.
  // É a cobertura real dessas telas — por isso elas ficam fora do coverage
  // unitário, como o resto do que fala com o Supabase.
  const authTests = auth
    ? `
  test('a tela de login carrega e mostra o formulário', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByLabel('Email')).toBeVisible()
    await expect(page.getByLabel('Senha')).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Entrar' }),
    ).toBeVisible()
  })

  test('a rota protegida redireciona quem não está logado', async ({
    page,
  }) => {
    await page.goto('/app')
    // O gate é no servidor: sem sessão, /app manda para /login.
    await expect(page).toHaveURL(/\\/login$/)
  })
`
    : ''

  return `import { test, expect } from '@playwright/test'

test.describe('smoke', () => {${authTests}
  test('a home carrega com o título do projeto', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle('${escapeJs(projectName)}')
    await expect(
      page.getByRole('heading', { level: 1, name: '${escapeJs(projectName)}' })
    ).toBeVisible()
  })

  test('responde com os cabeçalhos de segurança', async ({ page }) => {
    const response = await page.goto('/')
    const headers = response?.headers() ?? {}

    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['content-security-policy']).toContain("default-src 'self'")
  })

  /**
   * Este teste existe por causa de um bug real, e é o único que o pegaria.
   *
   * Ao trocar a CSP para nonce, a home continuava pré-renderizada estática —
   * HTML sem nonce nenhum. O navegador bloqueou TODOS os scripts. A página
   * carregava, aparecia perfeita, e não respondia a nada, porque nunca
   * hidratou. Build passava, título batia, cabeçalho de segurança batia.
   *
   * Só olhando o console do navegador dá para ver.
   */
  test('nenhum script é bloqueado pela própria CSP', async ({ page }) => {
    const violacoes: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) {
        violacoes.push(msg.text())
      }
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    expect(violacoes, violacoes.join(' | ')).toEqual([])
  })

  test('a aplicação hidrata de verdade', async ({ page }) => {
    await page.goto('/')
    // React só marca a raiz com esta chave interna depois de hidratar. HTML
    // servido sem script executado não tem nenhuma.
    const hidratou = await page.evaluate(() => {
      const raiz = document.querySelector('main')
      if (!raiz) return false
      return Object.keys(raiz).some((k) => k.startsWith('__react'))
    })
    expect(hidratou).toBe(true)
  })

  test('a CSP não autoriza script inline por origem', async ({ page }) => {
    const response = await page.goto('/')
    const csp = response?.headers()['content-security-policy'] ?? ''

    expect(csp).toContain("'strict-dynamic'")
    expect(csp).toMatch(/'nonce-[A-Za-z0-9+/=]+'/)
  })

  test('não vaza a service role key para o cliente', async ({ page }) => {
    await page.goto('/')
    const html = await page.content()

    expect(html).not.toContain('service_role')
    expect(html).not.toMatch(/SUPABASE_SERVICE_ROLE/)
  })
})
`
}

// ═════════════════════════════════════════════════════════════
// Gates
// ═════════════════════════════════════════════════════════════

function ciWorkflow(projectName: string): string {
  return `name: Gates — ${projectName}

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read
  security-events: write
  # gitleaks lê os commits do PR para varrer só o que mudou; sem isto ele
  # recebe 403 em /pulls/N/commits e o job falha sem ter escaneado nada.
  pull-requests: read
  actions: read

jobs:
  quality:
    name: Tipos, lint e auditoria
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run audit:security -- --strict

  test:
    name: Testes e cobertura
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - run: npm run test:coverage

  rls:
    name: Políticas RLS
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '20'
          cache: npm
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - run: supabase start

      # O start sobe o banco, mas quem aplica as migrations do repositório
      # é o db reset. Sem isto o teste falha com "Could not find the table
      # ... in the schema cache", e o gate de RLS passa a acusar ausência de
      # tabela em vez de falha de policy.
      - name: Aplicar as migrations do repositório
        run: supabase db reset --no-seed

      - name: Exportar credenciais locais
        run: |
          echo "SUPABASE_URL=$(supabase status -o env | grep API_URL | cut -d= -f2- | tr -d '\\"')" >> $GITHUB_ENV
          echo "SUPABASE_ANON_KEY=$(supabase status -o env | grep ANON_KEY | cut -d= -f2- | tr -d '\\"')" >> $GITHUB_ENV
          echo "SUPABASE_SERVICE_ROLE_KEY=$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2- | tr -d '\\"')" >> $GITHUB_ENV
      - run: npm ci
      - name: Provar isolamento entre contas
        run: npm run test:rls

  dependencies:
    name: Vulnerabilidades
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - run: npm audit --audit-level=high

  secrets:
    name: Varredura de segredos
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}

  build:
    name: Build de produção
    runs-on: ubuntu-latest
    needs: [quality, test]
    env:
      NEXT_PUBLIC_SUPABASE_URL: \${{ secrets.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co' }}
      NEXT_PUBLIC_SUPABASE_ANON_KEY: \${{ secrets.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder' }}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - run: npm run build

  e2e:
    name: End-to-end
    runs-on: ubuntu-latest
    needs: [build]
    env:
      NEXT_PUBLIC_SUPABASE_URL: \${{ secrets.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co' }}
      NEXT_PUBLIC_SUPABASE_ANON_KEY: \${{ secrets.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder' }}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium webkit
      - run: npm run test:e2e
      - uses: actions/upload-artifact@v5
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7
`
}

function dependabotConfig(): string {
  return `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
    groups:
      dev-dependencies:
        dependency-type: development
    ignore:
      # Estas ferramentas sobem de versão maior em conjunto: o ESLint do Next
      # precisa suportar a versão do TypeScript, e o React precisa casar com
      # o Next. Um salto automático de uma delas quebra o CI de um projeto
      # recém-criado — atualize as quatro de uma vez, de propósito.
      - dependency-name: typescript
        update-types: [version-update:semver-major]
      - dependency-name: eslint
        update-types: [version-update:semver-major]
      - dependency-name: eslint-config-next
        update-types: [version-update:semver-major]
      - dependency-name: next
        update-types: [version-update:semver-major]
      - dependency-name: react
        update-types: [version-update:semver-major]
      - dependency-name: react-dom
        update-types: [version-update:semver-major]
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: monthly
`
}

/**
 * Lockfile pré-resolvido do conjunto fixo de dependências do template.
 *
 * Sem ele o projeto nasce com o CI quebrado: `npm ci` e o `cache: npm` do
 * actions/setup-node exigem lockfile, e o job falha antes de instalar nada.
 * Como as dependências do template são fixas, o lock é resolvido uma vez e
 * versionado aqui — o que também dá build reproduzível ao usuário.
 *
 * Regenerar após mudar DEPENDENCIES ou DEV_DEPENDENCIES:
 *   npx tsx scripts/dev/regenerate-template-lock.ts
 */
function packageLock(projectName: string): string {
  const lockPath = path.join(
    process.cwd(),
    'src',
    'lib',
    'templates',
    'assets',
    'package-lock.json',
  )

  const raw = fs.readFileSync(/* turbopackIgnore: true */ lockPath, 'utf8')
  const lock = JSON.parse(raw) as {
    name: string
    packages: Record<string, { name?: string }>
  }

  // O nome no lock precisa bater com o do package.json, senão o npm avisa.
  lock.name = projectName
  const root = lock.packages['']
  if (root) root.name = projectName

  return `${JSON.stringify(lock, null, 2)}\n`
}

/**
 * O script de auditoria é o mesmo que o Supremo roda em si próprio.
 *
 * Ele é lido do disco em vez de duplicado numa string: uma cópia paralela
 * divergiria na primeira correção feita de um lado só.
 */
function securityAuditScript(): string {
  const scriptPath = path.join(process.cwd(), 'scripts', 'security-audit.js')

  try {
    return fs.readFileSync(/* turbopackIgnore: true */ scriptPath, 'utf8')
  } catch {
    // Cai no stub abaixo, que falha alto em vez de passar em silêncio.
  }

  // Sem o arquivo, o gate falha alto em vez de passar em silêncio.
  return `#!/usr/bin/env node
console.error(
  'Script de auditoria não foi copiado pelo scaffold. ' +
    'Recrie o projeto ou copie scripts/security-audit.js do Supremo.'
)
process.exit(1)
`
}

// ═════════════════════════════════════════════════════════════
// Documentação
// ═════════════════════════════════════════════════════════════

function readme(projectName: string, description: string): string {
  return `# ${projectName}

${description}

## Rodando localmente

\`\`\`bash
npm install
cp .env.example .env.local   # preencha com as chaves do seu Supabase
npm run dev
\`\`\`

## Gates

Todos rodam no CI a cada pull request e precisam passar antes do merge.

| Comando | O que verifica |
| --- | --- |
| \`npm run typecheck\` | TypeScript strict, zero erros |
| \`npm run lint\` | ESLint, zero erros |
| \`npm test\` | Testes unitários |
| \`npm run test:coverage\` | Cobertura mínima de 70% |
| \`npm run test:rls\` | Isolamento entre contas no banco |
| \`npm run test:e2e\` | Fluxos críticos no navegador |
| \`npm run audit:security\` | RLS, autorização, IDOR, segredos, XSS |

A análise estática (CodeQL) roda pelo code scanning gerenciado do GitHub, em
Settings › Code security — não há job dela no workflow.

Antes de abrir um PR:

\`\`\`bash
npm run typecheck && npm run lint && npm test && npm run build
\`\`\`

## Autenticação

Os helpers do Supabase estão em \`lib/supabase/\`. O middleware que renova a
sessão vem como \`lib/supabase/proxy.example.ts\`, **desligado**: ele só faz
sentido depois que existir login. Para ativar, mova para \`proxy.ts\` na raiz.

## Banco de dados

Migrations ficam versionadas em \`supabase/migrations/\`. Toda tabela nova
precisa de RLS e do teste correspondente em \`supabase/rls.rls.test.ts\` —
o CI reprova o PR sem isso.

## Arquitetura

Leia [agents.md](./agents.md) para o contexto completo e as regras que valem
neste repositório.
`
}

function agentsMd(projectName: string, description: string): string {
  return `# ${projectName} — contexto para agentes de IA

## O que é
${description}

## Stack
- Next.js 16 (App Router) + React 19, TypeScript strict
- Supabase (Postgres + Auth + RLS)
- Tailwind CSS v4
- Vitest + Playwright

## Regras de arquitetura

### Segurança
- Toda validação acontece no servidor. Nunca no cliente.
- RLS ativo em todas as tabelas, sem exceção.
- Nunca expor a service role key ao bundle do cliente.
- Nunca confiar em \`user_id\` vindo do corpo da requisição — use \`auth.uid()\`.
- Server Actions para mutação; Route Handlers para integração externa.
- Toda Server Action começa verificando a sessão.

### Código
- Zero \`any\`. Tipos explícitos.
- Nenhuma lógica de negócio dentro de componente React.
- Zod para validar toda entrada de servidor.
- Erro tratado explicitamente — nunca \`catch\` vazio.

### Banco
- Migrations versionadas em \`supabase/migrations/\`, nunca aplicadas só por API.
- Foreign key com \`ON DELETE\` explícito.
- Índice em toda foreign key.
- \`created_at\` e \`updated_at\` em toda tabela.
- **Toda tabela nova exige um teste de RLS.** Sem ele o PR não passa.

### Testes
Escreva o teste junto com o código, não depois. Cobertura mínima de 70%,
exigida pelo CI — não é sugestão.

## Fluxo de trabalho
1. Trabalhe em branch, nunca na \`main\`.
2. Abra pull request.
3. Espere os gates. Se algum falhar, leia o log e corrija.
4. Merge só com tudo verde.

Este projeto é gerenciado pelo Supremo. O MCP remoto expõe estas regras via
\`get_project_context\` — elas valem de qualquer máquina.
`
}

function claudeMd(projectName: string): string {
  return `# CLAUDE.md — ${projectName}

Leia \`agents.md\` primeiro. Este arquivo complementa com comportamento.

## Sempre
- Ler \`agents.md\` e \`SECURITY.md\` antes de escrever código
- Implementar do servidor para fora
- Ativar RLS em toda tabela nova **e escrever o teste de isolamento**
- Validar entrada com Zod no servidor
- Rodar \`npm run typecheck && npm run lint && npm test\` antes de propor mudança

## Nunca
- \`any\` no TypeScript
- \`console.log\` em produção
- Lógica de negócio em componente React
- Tabela sem RLS
- Segredo em código
- Validação de acesso no cliente
- Commit direto na \`main\`

## Commits
\`feat:\` \`fix:\` \`refactor:\` \`test:\` \`security:\` \`docs:\` \`chore:\`

Um commit por mudança lógica.

## Quando um gate falha
Leia o log do job, corrija a causa, proponha de novo. Não desabilite o teste,
não use \`skip\`, não afrouxe o threshold. Se o gate está errado, corrija o
gate num PR separado e explique por quê.
`
}

function securityMd(projectName: string): string {
  return `# SECURITY.md — ${projectName}

## Modelo de ameaça
Aplicação multiusuário sobre Supabase. O risco principal é vazamento entre
contas: usuário A alcançar dado do usuário B.

## Template obrigatório de tabela

\`\`\`sql
CREATE TABLE minha_tabela (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_minha_tabela_user_id ON minha_tabela(user_id);
ALTER TABLE minha_tabela ENABLE ROW LEVEL SECURITY;

CREATE POLICY "minha_tabela_select_own" ON minha_tabela
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "minha_tabela_insert_own" ON minha_tabela
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "minha_tabela_update_own" ON minha_tabela
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "minha_tabela_delete_own" ON minha_tabela
  FOR DELETE USING (auth.uid() = user_id);
\`\`\`

E o teste correspondente em \`supabase/rls.rls.test.ts\`.

## Proibido
- \`USING (true)\` ou \`WITH CHECK (true)\` em qualquer policy
- \`service_role\` fora do servidor
- Decidir autorização a partir de JWT decodificado no cliente
- \`dangerouslySetInnerHTML\` sem sanitização
- \`eval\` e \`new Function\`
- Desabilitar RLS "temporariamente"

## Cabeçalhos
A Content-Security-Policy fica em \`proxy.ts\`, porque usa um nonce por
requisição — cabeçalho estático não consegue gerar isso, e sem nonce a
política precisaria autorizar \`'unsafe-inline'\`, que é exatamente o que um
XSS injeta. Os demais ficam em \`next.config.ts\`. Todos verificados por E2E:
Content-Security-Policy, Strict-Transport-Security, X-Frame-Options,
X-Content-Type-Options, Referrer-Policy, Permissions-Policy.

## Reportando uma vulnerabilidade
Abra issue privada de segurança no GitHub. Não abra PR público com o exploit.

## Resposta a incidente
1. Revogue a credencial exposta antes de qualquer outra coisa
2. Crie branch \`security/descricao\`
3. Corrija e escreva o teste que impede a regressão
4. Rode a suíte completa
5. Peça revisão antes do merge
`
}

// ─────────────────────────────────────────────────────────────

function escapeJs(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ')
}

function escapeJsx(value: string): string {
  return value.replace(/[{}]/g, '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
