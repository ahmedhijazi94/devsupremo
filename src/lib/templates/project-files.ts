import fs from 'node:fs'
import path from 'node:path'
import { generateRlsTest, inferTablesFromMigration } from './rls-tests'
import { harnessFiles, harnessPackageScripts } from './harness'
import {
  capabilitiesForKind,
  inferSecurityProfile,
  type CapabilityId,
} from '@/lib/capabilities'

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

// 2.1.1: cookies do preview agora com Partitioned (CHIPS) — sem ele o Chrome
// moderno descarta o cookie de terceira-parte no iframe mesmo com SameSite=None,
// e o login não persistia no preview. 2.1.0 trouxe SameSite=None, o inspector e
// o CI adaptativo. Projeto atrás mostra o cartão "Atualizar base".
// 2.2.0: scaffold v2 — local dev harness (verify adaptativo, setup:local, git
// hooks), identidade do projeto em .supremo/project.json e capabilities.
// 2.3.0: banco online via Supabase CLI — o bootstrap linka o checkout ao remoto;
// regras de agente (migration = fonte da verdade, guarda de op destrutiva) e
// supabase/.temp gitignored.
// 2.4.0: config.toml nasce em Postgres 17 (default atual do Supabase; o bootstrap
// ainda ajusta à versão real do remoto); regras de agente refinadas (db reset
// --linked, confirmar o project-ref antes de qualquer mutação remota).
// 2.5.0: Supabase CLI pinada como devDependency (npx supabase local, nunca a
// global) — versão idêntica em qualquer máquina/agente; agents/CLAUDE usam npx.
// 2.6.0: agents.md -> AGENTS.md (nome canônico p/ descoberta por Codex & cia);
// ciclo obrigatório explícito (implementa→testa→migration/RLS→npm run verify→
// branch/commit/push/PR→CI verde→nunca merge sem autorização) em AGENTS/CLAUDE.
// 3.0.0: WORKFLOW v3 — desenvolvimento rápido estilo Lovable. CI ASSÍNCRONA: o
// agente NUNCA espera/polla a CI após um push normal; segue desenvolvendo. Auto-merge
// é do GitHub (só o HEAD atual validado entra na main; SHA verde antigo não libera
// SHA novo). Preview/HMR persistente no loop. verify adaptativo (FULL não é ritual).
// Trata a corrida de auto-merge durante a edição (preserva local → nova branch da
// main). main protegida (sem push direto/force/bypass). Destrutivo continua exigindo
// humano. concurrency+cancel-in-progress já na ci.yml.
// 3.1.0: experiência Lovable sem perder segurança. Preview PERSISTENTE (supervisor
// scripts/preview.mjs: detached, pidfile, porta estável, health, reuse/restart —
// sobrevive ao turno). Fast dev loop por RISCO (LOW/MEDIUM/HIGH; pesado em background).
// Checkpoint por pedido + push assíncrono do Supremo (agente não pede push/merge).
// AGENTS/CLAUDE: preview:ensure, hot path, anti-churn de infra em microfeature.
// 3.2.0 (v3.1 item 4): checkpoint/push SILENCIOSO. O agente só faz `checkpoint`
// LOCAL; o checkpoint daemon empurra em background com token efêmero escopado ao
// repo (contents:write; +workflows:write só em diff de workflows), emitido sob
// demanda pelo Supremo, nunca persistido/logado. Identidade da máquina no keychain
// (device flow do bootstrap; revogável). O agente NUNCA faz git push/branch/PR.
export const TEMPLATE_VERSION = '3.2.0'

/** Versão do baseline de segurança embutido no scaffold. */
export const SECURITY_BASELINE_VERSION = '2.0.0'

export interface FileEntry {
  path: string
  content: string
  mode?: '100644' | '100755'
}

/**
 * Que tipo de app nasce. Uma decisão arquitetural, cara de reverter, então
 * escolhida na criação em vez de adivinhada.
 *
 *  - public: site sem usuários. Sem login, sem tabela de dono. RLS em
 *    auth.uid() sem login trancaria tudo fechado, então essa camada não vem.
 *  - solo: app com login e dados por usuário. Cada linha é de um user_id.
 *    O caso central.
 *  - team: multi-tenant. O dado pertence a uma organização, e quem enxerga é
 *    decidido por uma tabela de sócios. É o prédio: vários times, cada um no
 *    seu andar.
 */
export type ProjectKind = 'public' | 'solo' | 'team'

export interface TemplateOptions {
  projectName: string
  description: string
  /** Padrão: 'solo'. Ver ProjectKind. */
  kind?: ProjectKind
  /**
   * Capabilities habilitadas (CORE + capabilities). Se omitido, deriva do kind
   * (ponte legada). Capability desligada não deixa rastro no scaffold.
   */
  capabilities?: CapabilityId[]
  /** Id do projeto no Supremo — vai para .supremo/project.json (não sensível). */
  projectId?: string
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
  // CLI do Supabase PINADA no projeto: o bootstrap e o agente usam esta versão
  // local (node_modules/.bin/supabase), nunca uma instalação global arbitrária —
  // dois computadores/agentes se comportam igual.
  supabase: '2.116.0',
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

/** O gate de isolamento — obrigatório no modo rápido só se o projeto escolher. */
export const RLS_GATE = 'Políticas RLS'

/**
 * Gates baratos que pegam catástrofe (app não compila, segredo vazado, dep
 * vulnerável) em segundos. Ficam SEMPRE obrigatórios, inclusive no modo rápido:
 * pular não economiza tempo relevante e o custo de deixar passar é alto.
 */
export const FAST_GATES = [
  'Tipos, lint e auditoria',
  'Vulnerabilidades',
  'Varredura de segredos',
  'Build de produção',
] as const

/**
 * Checks obrigatórios para o merge, conforme o modo do projeto. Modo rápido
 * exige só os baratos (+ RLS, se o projeto pediu 'block'). Os lentos — testes e
 * E2E — ainda RODAM e reportam, só não travam o merge no modo rápido.
 */
export function requiredGates(
  fastMode: boolean,
  rlsMode: 'block' | 'warn',
): string[] {
  if (!fastMode) return [...CI_JOB_NAMES]
  return rlsMode === 'block' ? [...FAST_GATES, RLS_GATE] : [...FAST_GATES]
}

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
  const kind = options.kind ?? 'solo'
  const auth = kind !== 'public'

  // Capabilities: explícitas ou derivadas do kind (ponte legada). O perfil de
  // segurança é inferido delas (kind é só sinal). Vão para .supremo/project.json.
  const capabilities = options.capabilities ?? capabilitiesForKind(kind)
  const securityProfile = inferSecurityProfile(capabilities, { kind })

  // A migration segue o tipo de app: público não tem tabela de dono; solo tem
  // dados por usuário; team tem organizações, sócios e recursos de tenant.
  const migration =
    kind === 'public'
      ? publicMigration()
      : kind === 'team'
        ? teamMigration()
        : initialMigration()

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
    { path: '.nvmrc', content: '22\n' },

    // ── Aplicação ─────────────────────────────────────────────
    { path: 'app/layout.tsx', content: appLayout(projectName, summary) },
    { path: 'app/page.tsx', content: appPage(projectName, summary, auth) },
    { path: 'app/globals.css', content: globalsCss() },
    { path: 'lib/utils.ts', content: libUtils() },

    // ── Design system ─────────────────────────────────────────
    // Primitivos prontos para o agente construir telas coerentes. Ficam em
    // components/ui, fora do coverage unitário: são apresentação, cobertos
    // pelo E2E através das páginas.
    { path: 'components/ui/button.tsx', content: uiButton() },
    { path: 'components/ui/card.tsx', content: uiCard() },
    { path: 'components/ui/input.tsx', content: uiInput() },
    { path: 'components/ui/badge.tsx', content: uiBadge() },
    { path: 'components/preview-inspector.tsx', content: previewInspector() },
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
    { path: 'AGENTS.md', content: agentsMd(projectName, summary) },
    { path: 'CLAUDE.md', content: claudeMd(projectName) },
    { path: 'SECURITY.md', content: securityMd(projectName) },

    // ── Identidade do projeto (metadata NÃO sensível) ─────────
    {
      path: '.supremo/project.json',
      content: supremoProjectJson({
        capabilities,
        securityProfile,
        ...(options.projectId ? { projectId: options.projectId } : {}),
      }),
    },
  ]

  // ── Local dev harness (verify adaptativo, setup:local, git hooks) ─────────
  for (const [p, content] of Object.entries(harnessFiles())) {
    files.push({
      path: p,
      content,
      mode: p.startsWith('.githooks/') ? '100755' : '100644',
    })
  }

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

// ─────────────────────────────────────────────────────────────
// Atualização de base — quais arquivos o template pode reescrever
// ─────────────────────────────────────────────────────────────

/**
 * Os arquivos de base ("rails"): infraestrutura pura que o Supremo é dono, não
 * o app. Não mora funcionalidade aqui — o agente não edita esses à mão. São
 * exatamente onde os consertos entram (cookies do preview no cliente/servidor
 * Supabase e no proxy, o inspector, o CI adaptativo), então atualizar a base de
 * um projeto que já existe traz esses consertos sem recriar o projeto.
 *
 * O que NÃO está aqui é scaffold — página, migration, teste do app, doc,
 * package.json. É onde a funcionalidade, o schema e as dependências do app
 * vivem. Numa atualização esses só nascem se faltarem; nunca são sobrescritos,
 * porque sobrescrever apagaria o trabalho do agente.
 *
 * Ainda assim a atualização vira um PR pelos gates, revisável: se um projeto
 * customizou um arquivo de base à mão (um domínio a mais na CSP do next.config,
 * por exemplo), o diff mostra antes do merge.
 */
export const MANAGED_PATHS: ReadonlySet<string> = new Set([
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
  '.github/dependabot.yml',
  'scripts/security-audit.js',
  // Local dev harness (base infra do Supremo)
  'scripts/verify.mjs',
  'scripts/setup-local.mjs',
  '.githooks/pre-commit',
  '.githooks/pre-push',
])

/** Este arquivo é rail (o Supremo reescreve) ou scaffold (só cria se faltar)? */
export function isManagedPath(path: string): boolean {
  return MANAGED_PATHS.has(path)
}

// ═════════════════════════════════════════════════════════════
// Configuração
// ═════════════════════════════════════════════════════════════

function packageJson(projectName: string): string {
  // O harness (verify adaptativo, setup:local, local:start/stop, security:*)
  // entra junto dos scripts base. Chaves existentes vencem em conflito.
  const scripts = { ...harnessPackageScripts(), ...SCRIPTS }
  return `${JSON.stringify(
    {
      name: projectName,
      version: '0.1.0',
      private: true,
      engines: { node: '>=20' },
      scripts,
      dependencies: DEPENDENCIES,
      devDependencies: DEV_DEPENDENCIES,
    },
    null,
    2,
  )}\n`
}

/**
 * Identidade do projeto — metadata NÃO sensível (seção 25). NUNCA token, secret,
 * service_role ou chave. Registra versão do scaffold/baseline e capabilities.
 */
function supremoProjectJson(opts: {
  projectId?: string
  capabilities: CapabilityId[]
  securityProfile: string
}): string {
  return `${JSON.stringify(
    {
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      // API do Supremo que o checkpoint daemon chama (push-grant/ensure-pr).
      supremoUrl: supremoOrigin(),
      scaffoldVersion: TEMPLATE_VERSION,
      securityBaselineVersion: SECURITY_BASELINE_VERSION,
      securityProfile: opts.securityProfile,
      capabilities: opts.capabilities,
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

# Supabase CLI: estado do link (project-ref etc.) e branches locais. O ref não é
# segredo, mas é por-máquina e não deve ir ao Git (cada checkout linka o seu).
supabase/.temp/
supabase/.branches/

# Supremo v3.1: estado por-máquina do supervisor de preview (não versionar).
.supremo/preview.pid
.supremo/preview.log

# Supremo v3.1: estado por-máquina do checkpoint daemon — fila de checkpoints,
# pid/log do daemon e worktree efêmera de integração. NUNCA guarda secret (o
# secret da máquina fica no keychain do SO). Tudo por-máquina; fora do Git.
.supremo/checkpoints/

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
import { Inter } from 'next/font/google'
import { PreviewInspector } from '@/components/preview-inspector'
import './globals.css'

// Inter, servida pelo próprio Next (self-hosted) — sem requisição externa,
// então nada de bater na CSP. É a tipografia que dá o ar caprichado.
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

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

  // O inspetor de seleção visual só faz sentido no preview do Supremo — em
  // produção ele nem é montado.
  const isPreview =
    process.env.SUPREMO_PREVIEW === '1' ||
    process.env.VERCEL_ENV === 'preview'

  return (
    <html lang="pt-BR" className={inter.variable} suppressHydrationWarning>
      <body className="bg-background text-foreground min-h-dvh antialiased">
        {children}
        {isPreview && <PreviewInspector />}
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
  // Link só é importado quando há login — importação não usada quebra o lint.
  const linkImport = auth ? `import Link from 'next/link'\n` : ''
  const cta = auth
    ? `
          <div className="flex flex-wrap gap-3 pt-2">
            <Link href="/login">
              <Button size="lg">
                Entrar
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>
`
    : ''

  return `${linkImport}import { ArrowRight, ShieldCheck, GitPullRequest } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

export default function HomePage() {
  return (
    <main className="relative isolate overflow-hidden">
      {/* Brilho suave de fundo — dá profundidade sem pesar */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 -z-10 h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-accent/15 blur-3xl"
      />

      <div className="mx-auto flex min-h-dvh max-w-4xl flex-col justify-center px-6 py-20">
        <div className="space-y-6">
          <Badge>
            <span className="size-1.5 rounded-full bg-accent" />
            Criado com Supremo
          </Badge>

          <h1 className="text-4xl font-semibold sm:text-6xl">
            ${escapeJsx(projectName)}
          </h1>

          <p className="text-muted max-w-2xl text-lg leading-relaxed sm:text-xl">
            ${escapeJsx(description)}
          </p>
${cta}
          <div className="grid gap-4 pt-8 sm:grid-cols-2">
            <Card>
              <ShieldCheck className="text-accent h-6 w-6" />
              <CardTitle className="mt-3">Seguro por padrão</CardTitle>
              <CardDescription>
                Toda tabela nasce com Row Level Security e um teste que prova o
                isolamento entre contas — sozinho, ninguém lê o dado do outro.
              </CardDescription>
            </Card>
            <Card>
              <GitPullRequest className="text-accent h-6 w-6" />
              <CardTitle className="mt-3">Testado a cada mudança</CardTitle>
              <CardDescription>
                Tipos, lint, testes, cobertura, auditoria de segurança e E2E
                rodam antes de qualquer merge. Nada quebrado chega na main.
              </CardDescription>
            </Card>
          </div>
        </div>
      </div>
    </main>
  )
}
`
}

function globalsCss(): string {
  return `@import "tailwindcss";

/**
 * Sistema visual — gerado pelo Supremo.
 *
 * Superfícies em camadas (fundo → cartão → elevado), uma cor de ação só,
 * tipografia Inter, cantos generosos. Claro e escuro desenhados de propósito,
 * não invertidos no chute. Use os tokens (bg-surface, text-muted, bg-accent…)
 * em vez de cores cruas, e a interface inteira se mantém coerente.
 */

@theme {
  /* Superfícies */
  --color-background: oklch(98.5% 0.003 265);
  --color-surface: oklch(100% 0 0);
  --color-elevated: oklch(96.8% 0.004 265);

  /* Texto */
  --color-foreground: oklch(21% 0.02 265);
  --color-muted: oklch(55% 0.02 265);

  /* Traço */
  --color-border: oklch(92% 0.005 265);
  --color-border-strong: oklch(86% 0.008 265);

  /* Ação */
  --color-accent: oklch(54% 0.2 267);
  --color-accent-hover: oklch(49% 0.2 267);
  --color-accent-foreground: oklch(99% 0 0);

  /* Semânticas — para estado, não decoração */
  --color-success: oklch(92% 0.09 150);
  --color-success-foreground: oklch(42% 0.13 150);
  --color-warning: oklch(94% 0.09 85);
  --color-warning-foreground: oklch(50% 0.13 70);
  --color-danger: oklch(93% 0.06 25);
  --color-danger-foreground: oklch(51% 0.2 27);

  /* Cantos */
  --radius-xl: 1.25rem;
  --radius-lg: 0.875rem;
  --radius-md: 0.625rem;
  --radius-sm: 0.375rem;

  --font-sans: var(--font-inter), ui-sans-serif, system-ui, -apple-system,
    "Segoe UI", sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, monospace;
}

@media (prefers-color-scheme: dark) {
  @theme {
    --color-background: oklch(17% 0.015 265);
    --color-surface: oklch(21% 0.015 265);
    --color-elevated: oklch(25% 0.016 265);

    --color-foreground: oklch(96% 0.005 265);
    --color-muted: oklch(70% 0.015 265);

    --color-border: oklch(30% 0.012 265);
    --color-border-strong: oklch(38% 0.014 265);

    --color-accent: oklch(70% 0.17 270);
    --color-accent-hover: oklch(75% 0.16 270);
    --color-accent-foreground: oklch(17% 0.015 265);

    --color-success: oklch(30% 0.08 150);
    --color-success-foreground: oklch(85% 0.15 150);
    --color-warning: oklch(32% 0.08 80);
    --color-warning-foreground: oklch(88% 0.13 85);
    --color-danger: oklch(30% 0.09 25);
    --color-danger-foreground: oklch(84% 0.13 25);
  }
}

@layer base {
  html {
    -webkit-text-size-adjust: 100%;
  }

  body {
    background: var(--color-background);
    color: var(--color-foreground);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  /* Títulos: mais apertados e equilibrados, o que dá o ar caprichado. */
  h1, h2, h3, h4 {
    letter-spacing: -0.02em;
    text-wrap: balance;
  }

  ::selection {
    background: var(--color-accent);
    color: var(--color-accent-foreground);
  }

  :focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }

  * {
    scrollbar-width: thin;
    scrollbar-color: var(--color-border-strong) transparent;
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

// ═════════════════════════════════════════════════════════════
// Design system — primitivos
// ═════════════════════════════════════════════════════════════

function uiButton(): string {
  return `import { cn } from '@/lib/utils'

type Variant = 'primary' | 'secondary' | 'ghost'
type Size = 'sm' | 'md' | 'lg'

const base =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-md)] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50'

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-foreground hover:bg-accent-hover',
  secondary:
    'bg-elevated text-foreground border border-border hover:border-border-strong',
  ghost: 'text-muted hover:bg-elevated hover:text-foreground',
}

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-base',
}

export function buttonClass(variant: Variant = 'primary', size: Size = 'md') {
  return cn(base, variants[variant], sizes[size])
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: React.ComponentProps<'button'> & { variant?: Variant; size?: Size }) {
  return (
    <button className={cn(buttonClass(variant, size), className)} {...props} />
  )
}
`
}

function uiCard(): string {
  return `import { cn } from '@/lib/utils'

export function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'bg-surface rounded-[var(--radius-xl)] border border-border p-6 shadow-sm',
        className,
      )}
      {...props}
    />
  )
}

export function CardTitle({ className, ...props }: React.ComponentProps<'h3'>) {
  return (
    <h3
      className={cn('text-base font-semibold', className)}
      {...props}
    />
  )
}

export function CardDescription({
  className,
  ...props
}: React.ComponentProps<'p'>) {
  return <p className={cn('text-muted mt-1 text-sm', className)} {...props} />
}
`
}

function uiInput(): string {
  return `import { cn } from '@/lib/utils'

export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'bg-surface border-border placeholder:text-muted h-10 w-full rounded-[var(--radius-md)] border px-3 text-sm transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-accent',
        className,
      )}
      {...props}
    />
  )
}

export function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label className={cn('text-sm font-medium', className)} {...props} />
  )
}
`
}

function uiBadge(): string {
  return `import { cn } from '@/lib/utils'

type Tone = 'default' | 'success' | 'warning' | 'danger'

const tones: Record<Tone, string> = {
  default: 'bg-elevated text-muted',
  success: 'bg-success text-success-foreground',
  warning: 'bg-warning text-warning-foreground',
  danger: 'bg-danger text-danger-foreground',
}

export function Badge({
  tone = 'default',
  className,
  ...props
}: React.ComponentProps<'span'> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        tones[tone],
        className,
      )}
      {...props}
    />
  )
}
`
}

// ═════════════════════════════════════════════════════════════
// Inspetor de preview — seleção visual de componentes
// ═════════════════════════════════════════════════════════════

/**
 * O inspetor que o Supremo usa para "selecionar componente" no preview.
 *
 * O preview roda num iframe de OUTRO domínio, então o Supremo não pode ler o
 * DOM daqui de fora — o navegador bloqueia. A ponte é este script, que só liga
 * no preview e conversa com o Supremo por postMessage: ele escuta o comando de
 * entrar em modo seleção, desenha o contorno no que o mouse passa, e ao clicar
 * devolve uma referência do componente (tag, texto, classes, contexto e HTML)
 * pronta para o usuário colar no prompt do agente.
 *
 * Nada disto aparece em produção: o layout só monta o inspetor quando o app
 * está rodando como preview.
 */
function previewInspector(): string {
  return `'use client'

import { useEffect } from 'react'

const SUPREMO_ORIGIN = '${supremoOrigin()}'

export function PreviewInspector() {
  useEffect(() => {
    let selectMode = false
    let hovered: HTMLElement | null = null

    function outline(el: HTMLElement | null, on: boolean) {
      if (!el) return
      el.style.outline = on ? '2px solid #7c5cff' : ''
      el.style.outlineOffset = on ? '2px' : ''
    }

    function onOver(event: MouseEvent) {
      if (!selectMode) return
      const el = event.target as HTMLElement
      if (hovered === el) return
      outline(hovered, false)
      hovered = el
      outline(el, true)
    }

    function describe(el: HTMLElement) {
      const landmarks: string[] = []
      let node: HTMLElement | null = el
      let heading = ''
      while (node && landmarks.length < 3) {
        if (/^(section|main|header|footer|nav|form|article|aside)$/i.test(node.tagName)) {
          landmarks.unshift(node.tagName.toLowerCase())
          if (!heading) {
            const h = node.querySelector('h1, h2, h3')
            if (h && h.textContent) heading = h.textContent.trim().slice(0, 60)
          }
        }
        node = node.parentElement
      }
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
        classes: el.getAttribute('class') || '',
        heading,
        landmarks,
        html: el.outerHTML.replace(/\\s+/g, ' ').slice(0, 500),
      }
    }

    function onClick(event: MouseEvent) {
      if (!selectMode) return
      event.preventDefault()
      event.stopPropagation()
      const payload = describe(event.target as HTMLElement)
      window.parent.postMessage({ type: 'supremo:selected', payload }, SUPREMO_ORIGIN)
    }

    function onMessage(event: MessageEvent) {
      if (event.origin !== SUPREMO_ORIGIN) return
      const data = event.data as { type?: string; on?: boolean }
      if (data.type !== 'supremo:select-mode') return
      selectMode = Boolean(data.on)
      document.body.style.cursor = selectMode ? 'crosshair' : ''
      if (!selectMode) {
        outline(hovered, false)
        hovered = null
      }
    }

    window.addEventListener('mouseover', onOver, true)
    window.addEventListener('click', onClick, true)
    window.addEventListener('message', onMessage)
    // Avisa o Supremo que o inspetor está pronto neste preview.
    window.parent.postMessage({ type: 'supremo:inspector-ready' }, SUPREMO_ORIGIN)

    return () => {
      window.removeEventListener('mouseover', onOver, true)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('message', onMessage)
    }
  }, [])

  return null
}
`
}

// ═════════════════════════════════════════════════════════════
// Login — só quando o app tem usuários
// ═════════════════════════════════════════════════════════════

/** A página de login: uma casca server que monta o formulário client. */
function loginPage(projectName: string): string {
  return `import { LoginForm } from './login-form'
import { Card } from '@/components/ui/card'

export const metadata = { title: 'Entrar — ${escapeJs(projectName)}' }

export default function LoginPage() {
  return (
    <main className="relative isolate flex min-h-dvh items-center justify-center overflow-hidden px-6 py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 -z-10 h-[32rem] w-[32rem] -translate-x-1/2 rounded-full bg-accent/15 blur-3xl"
      />
      <Card className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold">Entrar</h1>
        <p className="text-muted mt-1 mb-6 text-sm">
          Acesse a sua conta ou crie uma nova.
        </p>
        <LoginForm />
      </Card>
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
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'

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
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password">Senha</Label>
        <Input
          id="password"
          type="password"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      {error && <p className="text-danger-foreground text-sm">{error}</p>}

      <Button type="submit" disabled={busy} className="w-full">
        {busy ? '...' : mode === 'signin' ? 'Entrar' : 'Criar conta'}
      </Button>

      <button
        type="button"
        onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
        className="text-muted hover:text-foreground w-full text-center text-sm"
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
import { Button } from '@/components/ui/button'
import { Card, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

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
      <div className="space-y-3">
        <Badge tone="success">Sessão ativa</Badge>
        <div>
          <p className="text-muted text-sm">
            Área logada de ${escapeJsx(projectName)}
          </p>
          <h1 className="mt-1 text-3xl font-semibold">Olá, {user.email}</h1>
        </div>
      </div>

      <Card>
        <CardTitle>Seus dados ficam só seus</CardTitle>
        <CardDescription>
          Esta rota só abre autenticado, e cada linha que você guardar é
          isolada pela sua conta. O Row Level Security garante que ninguém mais
          leia o seu dado — provado por teste a cada mudança.
        </CardDescription>
      </Card>

      <form action="/auth/signout" method="post">
        <Button type="submit" variant="secondary">
          Sair
        </Button>
      </form>
    </main>
  )
}
`
}

/**
 * Migration multi-tenant: o prédio.
 *
 * orgs é o tenant, memberships liga usuário ↔ tenant, projects é um recurso
 * do tenant. A ordem importa: as tabelas primeiro, as policies depois, porque
 * a policy de orgs e a de projects referenciam memberships.
 *
 * A policy de memberships (ver o próprio vínculo) NÃO é opcional: sem ela, o
 * EXISTS das outras policies não enxerga nada e o app inteiro trava fechado.
 * Provado num Postgres real antes de virar template.
 */
function teamMigration(): string {
  return `-- ============================================================
-- Migration inicial — multi-tenant (organizações)
-- criada pelo Supremo
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

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

-- ------------------------------------------------------------
-- Tabelas
-- ------------------------------------------------------------

-- O tenant.
CREATE TABLE IF NOT EXISTS orgs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Quem pertence a qual organização.
CREATE TABLE IF NOT EXISTS memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES orgs(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE(org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_org_id ON memberships(org_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON memberships(user_id);

-- Perfil do usuário — existe mesmo no modelo de time.
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

-- Um recurso que pertence à organização, não ao usuário.
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES orgs(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_org_id ON projects(org_id);

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

-- Sócios: cada um vê o próprio vínculo. Esta policy é o que faz o EXISTS das
-- outras funcionar — sem ela, ninguém enxerga organização nem recurso.
CREATE POLICY "memberships_select_own" ON memberships
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "memberships_insert_own" ON memberships
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- Organização: um membro vê a própria org.
CREATE POLICY "orgs_select_member" ON orgs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = orgs.id AND m.user_id = auth.uid()
    )
  );

CREATE POLICY "orgs_update_member" ON orgs
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = orgs.id AND m.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = orgs.id AND m.user_id = auth.uid()
    )
  );

-- Perfil: dono direto.
CREATE POLICY "profiles_select_own" ON profiles
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "profiles_insert_own" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "profiles_update_own" ON profiles
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Recurso do tenant: só membro da organização dona toca nele.
CREATE POLICY "projects_all_member" ON projects
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = projects.org_id AND m.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = projects.org_id AND m.user_id = auth.uid()
    )
  );

CREATE TRIGGER orgs_updated_at
  BEFORE UPDATE ON orgs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
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
          // No preview (iframe de outro domínio) o cookie precisa de
          // SameSite=None; Secure para valer, E Partitioned (CHIPS) — sem ele
          // o Chrome moderno descarta cookie de terceira-parte mesmo com
          // SameSite=None, e o login não persiste.
          const cookieFix = isFramable
            ? { sameSite: 'none' as const, secure: true, partitioned: true }
            : {}
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, { ...options, ...cookieFix }),
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

  // No preview do Supremo o app roda num iframe de outro domínio, e o cookie
  // de sessão vira "terceira-parte" — o navegador o bloqueia, e o login não
  // persiste (volta para /login). SameSite=None; Secure faz o cookie valer no
  // iframe; Partitioned (CHIPS) é o que falta no Chrome moderno, que descarta
  // cookie de terceira-parte mesmo com SameSite=None. Fora do iframe, nada muda.
  const inIframe = typeof window !== 'undefined' && window.self !== window.top

  return createBrowserClient(url, key, {
    ...(inIframe
      ? { cookieOptions: { sameSite: 'none', secure: true, partitioned: true } }
      : {}),
  })
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

  // No preview (iframe de outro domínio) o cookie precisa de SameSite=None;
  // Secure, e Partitioned (CHIPS), senão o Chrome o trata como terceira-parte
  // e o descarta mesmo com SameSite=None.
  const preview =
    process.env.SUPREMO_PREVIEW === '1' ||
    process.env.VERCEL_ENV === 'preview'
  const cookieOptions = preview
    ? { sameSite: 'none' as const, secure: true, partitioned: true }
    : {}

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
              cookieStore.set(name, value, { ...options, ...cookieOptions })
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
# Casa com o default atual do Supabase (Postgres 17) para o checkout linkado não
# acusar "Local database version differs". O bootstrap ajusta este valor à versão
# real do projeto remoto, caso o Supremo tenha provisionado outra.
major_version = 17

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
 * contrariando a própria regra que escrevia no AGENTS.md.
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

  // Nota: não há um teste separado de "hidratação". O bug que importa — a CSP
  // bloquear TODO script e servir uma casca morta — é pego de forma robusta
  // pelo teste "nenhum script é bloqueado pela própria CSP" acima, que escuta
  // as violações de CSP no console. A versão anterior tentava provar isso lendo
  // chaves internas do React no DOM, que aparecem em Chromium mas não em WebKit
  // mesmo com a página hidratada — um teste que falhava por implementação, não
  // por comportamento. Testar o comportamento observável, na camada certa, é o
  // que mantém o gate rápido e sem falso negativo.

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

# ------------------------------------------------------------------
# Gates adaptativos, sem perder segurança.
#
# Os gates baratos (tipos, lint, build, auditoria, segredos, unitários)
# rodam SEMPRE. Os dois caros — RLS (sobe um Postgres) e E2E (dois
# navegadores) — rodam sempre como job, mas os passos pesados só executam se
# os arquivos que os alimentam mudaram. O RLS só pode reprovar se uma policy
# mudou (supabase/**); o E2E só se o app mudou. Nenhum pulo é por adivinhação
# de "parece seguro": é por dependência provável, e na dúvida roda.
#
# O job ainda reporta o check verde em segundos quando não é afetado, então a
# proteção de branch continua exigindo todos os gates.
# ------------------------------------------------------------------

jobs:
  changes:
    name: Áreas afetadas
    runs-on: ubuntu-latest
    outputs:
      db: \${{ steps.filter.outputs.db }}
      app: \${{ steps.filter.outputs.app }}
    steps:
      - uses: actions/checkout@v5
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            db:
              - 'supabase/**'
            app:
              - 'app/**'
              - 'components/**'
              - 'lib/**'
              - 'proxy.ts'
              - 'next.config.ts'
              - 'playwright.config.ts'
              - 'package.json'
              - 'package-lock.json'

  quality:
    name: Tipos, lint e auditoria
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '22'
          cache: npm
      # node_modules cacheado pelo lockfile: cache-hit pula o npm ci inteiro
      # (~40s por job). Instalação é determinística, então restaurar é seguro.
      - name: Cache node_modules
        id: modules
        uses: actions/cache@v4
        with:
          path: node_modules
          key: modules-\${{ runner.os }}-\${{ hashFiles('package-lock.json') }}
      - if: steps.modules.outputs.cache-hit != 'true'
        run: npm ci
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
          node-version: '22'
          cache: npm
      # node_modules cacheado pelo lockfile: cache-hit pula o npm ci inteiro
      # (~40s por job). Instalação é determinística, então restaurar é seguro.
      - name: Cache node_modules
        id: modules
        uses: actions/cache@v4
        with:
          path: node_modules
          key: modules-\${{ runner.os }}-\${{ hashFiles('package-lock.json') }}
      - if: steps.modules.outputs.cache-hit != 'true'
        run: npm ci
      - run: npm run test:coverage

  rls:
    name: Políticas RLS
    runs-on: ubuntu-latest
    needs: changes
    steps:
      - name: Não afetado — nenhuma policy mudou
        if: needs.changes.outputs.db != 'true'
        run: echo "Sem mudanca em supabase/** - as policies sao as mesmas, nada de isolamento novo a provar. Gate verde."

      - uses: actions/checkout@v5
        if: needs.changes.outputs.db == 'true'
      - uses: actions/setup-node@v5
        if: needs.changes.outputs.db == 'true'
        with:
          node-version: '22'
          cache: npm
      - uses: supabase/setup-cli@v1
        if: needs.changes.outputs.db == 'true'
        with:
          version: latest
      - if: needs.changes.outputs.db == 'true'
        run: supabase start

      # O start sobe o banco, mas quem aplica as migrations do repositório
      # é o db reset. Sem isto o teste falha com "Could not find the table
      # ... in the schema cache", e o gate de RLS passa a acusar ausência de
      # tabela em vez de falha de policy.
      - name: Aplicar as migrations do repositório
        if: needs.changes.outputs.db == 'true'
        run: supabase db reset --no-seed

      - name: Exportar credenciais locais
        if: needs.changes.outputs.db == 'true'
        run: |
          echo "SUPABASE_URL=$(supabase status -o env | grep API_URL | cut -d= -f2- | tr -d '\\"')" >> $GITHUB_ENV
          echo "SUPABASE_ANON_KEY=$(supabase status -o env | grep ANON_KEY | cut -d= -f2- | tr -d '\\"')" >> $GITHUB_ENV
          echo "SUPABASE_SERVICE_ROLE_KEY=$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2- | tr -d '\\"')" >> $GITHUB_ENV
      - if: needs.changes.outputs.db == 'true'
        run: npm ci
      - name: Provar isolamento entre contas
        if: needs.changes.outputs.db == 'true'
        run: npm run test:rls

  dependencies:
    name: Vulnerabilidades
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '22'
          cache: npm
      # node_modules cacheado pelo lockfile: cache-hit pula o npm ci inteiro
      # (~40s por job). Instalação é determinística, então restaurar é seguro.
      - name: Cache node_modules
        id: modules
        uses: actions/cache@v4
        with:
          path: node_modules
          key: modules-\${{ runner.os }}-\${{ hashFiles('package-lock.json') }}
      - if: steps.modules.outputs.cache-hit != 'true'
        run: npm ci
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
          node-version: '22'
          cache: npm
      # node_modules cacheado pelo lockfile: cache-hit pula o npm ci inteiro
      # (~40s por job). Instalação é determinística, então restaurar é seguro.
      - name: Cache node_modules
        id: modules
        uses: actions/cache@v4
        with:
          path: node_modules
          key: modules-\${{ runner.os }}-\${{ hashFiles('package-lock.json') }}
      - if: steps.modules.outputs.cache-hit != 'true'
        run: npm ci
      - run: npm run build

  e2e:
    name: End-to-end
    runs-on: ubuntu-latest
    needs: [build, changes]
    env:
      NEXT_PUBLIC_SUPABASE_URL: \${{ secrets.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co' }}
      NEXT_PUBLIC_SUPABASE_ANON_KEY: \${{ secrets.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder' }}
    steps:
      - name: Não afetado — o app não mudou
        if: needs.changes.outputs.app != 'true'
        run: echo "Sem mudanca em app/**, components/**, lib/**, proxy.ts ou config - a tela e a mesma. Gate verde."

      - uses: actions/checkout@v5
        if: needs.changes.outputs.app == 'true'
      - uses: actions/setup-node@v5
        if: needs.changes.outputs.app == 'true'
        with:
          node-version: '22'
          cache: npm
      - if: needs.changes.outputs.app == 'true'
        run: npm ci

      # Os binários dos navegadores são pesados e não mudam entre execuções.
      # Cacheados pela versão travada no lockfile, o install pula o download
      # (~100 MB) e só reaplica as libs do sistema — corta ~1 min por rodada.
      - name: Cache dos navegadores do Playwright
        if: needs.changes.outputs.app == 'true'
        uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: playwright-\${{ runner.os }}-\${{ hashFiles('package-lock.json') }}
      - if: needs.changes.outputs.app == 'true'
        run: npx playwright install --with-deps chromium webkit
      - if: needs.changes.outputs.app == 'true'
        run: npm run test:e2e
      - uses: actions/upload-artifact@v5
        if: failure() && needs.changes.outputs.app == 'true'
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

Leia [AGENTS.md](./AGENTS.md) para o contexto completo e as regras que valem
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

## Ciclo de desenvolvimento (v3.1 — rápido e assíncrono)

O usuário NÃO acompanha branch/PR/CI/merge — isso é infraestrutura invisível. A
experiência é: **usuário pede → você implementa → o preview atualiza → o usuário pede
outra coisa**. A CI roda em BACKGROUND e o auto-merge acontece sozinho quando todos os
required checks do HEAD atual ficam verdes.

### Preview PERSISTENTE (v3.1)
No início de todo pedido, garanta o preview com **\`npm run preview:ensure\`**. Ele é
INFRAESTRUTURA da sessão (processo desacoplado, porta estável, HMR) — reusa se já está
saudável, reinicia se morreu. **NUNCA** rode \`npm run dev\` à mão: um dev efêmero morre
quando seu comando/turno termina e o preview cai. Não mate/recrie o preview a cada
prompt; o HMR reflete as mudanças no mesmo servidor.

### Hot path × integração — por RISCO (v3.1)
Separe o que BLOQUEIA a resposta (hot path, proporcional ao risco) do que roda em
BACKGROUND (a CI é a barreira definitiva antes da main):

- **LOW** (CSS/layout/copy/componente visual sem regra sensível): só lint/typecheck do
  que mudou + testes relacionados. Segundos. NÃO rode build/suíte ampla/RLS aqui.
- **MEDIUM** (lógica/Server Action/API/feature normal): testes relacionados +
  typecheck/lint necessários.
- **HIGH/SECURITY** (migration/RLS/auth/multitenancy/secrets/permissions/billing/infra):
  gates locais mais fortes antes do checkpoint.

\`npm run verify\` é adaptativo e escolhe isso (QUICK/SECURITY/FULL) pelo git diff — use-o
e **não** rode \`verify:full\` em toda microalteração. LOW não é inseguro: o trabalho
pesado (build, suíte completa, RLS, CodeQL, security gates) roda em BACKGROUND/CI.

### Passos de cada pedido normal (v3.1)
1. \`npm run preview:ensure\` — garante o preview persistente (reusa se vivo).
2. **Implemente** a mudança; veja no preview (o HMR reflete na hora).
3. Crie/atualize **só os testes relacionados** (escritos junto).
4. Rode **\`npm run verify\`** (adaptativo, proporcional ao risco — ver acima).
5. Corrija falhas locais do hot path.
6. **Feche o pedido com UM checkpoint LOCAL** (o resumo é curto, uma linha):
   \`\`\`
   npm run checkpoint -- "<resumo do que mudou>"
   \`\`\`
   (equivale a \`supremo checkpoint "<resumo>"\`). Ele valida que há mudança, cria o
   commit do checkpoint, ENFILEIRA o envio e retorna na hora — **sem rede**.
7. **Devolva o controle ao usuário IMEDIATAMENTE.** O próximo pedido já pode começar.

Um checkpoint por pedido concluído — **nunca** agrupe vários pedidos num só, nunca
deixe um pedido sem checkpoint. É a base do "voltar para antes desta mensagem".

### Publicação é INFRAESTRUTURA — não é você (v3.1 item 4)
Depois do \`checkpoint\`, o **checkpoint daemon** (processo de background, como o preview)
autentica com a identidade DESTA máquina e ENVIA o checkpoint ao Supremo — **nenhuma
credencial GitHub existe nesta máquina**. O **backend** do Supremo é quem publica: deriva
a branch de integração, escreve com um token da App usado e revogado no servidor, garante
a PR — e o Control Plane faz CI e auto-merge na \`main\`. **Você não faz, não vê e não
espera nada disso; nem o daemon toca no GitHub diretamente.**

### O que o AGENTE NUNCA faz (v3.1)
- **NUNCA** rode \`git push\` (nem \`git commit\` de entrega — use \`checkpoint\`),
  \`git branch\`, \`git checkout -b\`, \`git merge\`, \`git rebase\` ou \`git push --force\`.
  Empurrar é trabalho do daemon; você só faz o checkpoint LOCAL.
- **NUNCA** abra/atualize/feche PR, nem sincronize a branch com a \`main\` na mão.
- **NUNCA** trate corrida de auto-merge você mesmo: se a PR anterior mergeou enquanto
  você editava, o **Supremo** detecta, rotaciona a branch de integração e integra só o
  delta ainda não integrado — sozinho, sem tocar o seu worktree e sem perder nada.
- **NUNCA espere a CI**; não faça polling. **NUNCA** peça push/merge ao usuário.
- **NUNCA** faça push direto na \`main\`; **NUNCA** faça force push na \`main\` (você nem
  empurra — quem publica é o backend do Supremo, sempre em branch de trabalho; a \`main\`
  é protegida e inalcançável pelo caminho normal).
- **NUNCA** faça bypass de required checks nem desative/afrouxe teste, threshold,
  ruleset ou gate para "ficar verde". Gate falhou → corrija o CÓDIGO (ou o teste, se
  ele estiver errado), nunca remova a barreira.
- **NUNCA** rode \`npm run dev\` à mão (mata o preview persistente) — use \`preview:ensure\`.
- **NUNCA** "melhore" infraestrutura numa microfeature (LOW): não edite \`AGENTS.md\`,
  \`CLAUDE.md\`, \`tsconfig*\`, CI, \`package.json\`, migrations ou config estrutural sem
  necessidade técnica concreta do pedido. Ler as regras é ok; mexer por impulso não.

### SEMPRE (v3.1)
- **Continue desenvolvendo enquanto a CI roda** e o daemon integra em background.
- Só o **HEAD atual validado** é auto-mergeado; verde de um SHA
  antigo nunca libera um SHA novo (o daemon preserva essa trava HEAD/SHA).
- Uma **falha crítica de segurança** (RLS, auth, isolamento tenant, migration inválida,
  secret leak, IDOR, quebra estrutural de build) deve ser **corrigida antes** de
  construir trabalho dependente sobre ela.

### Falha de CI de um checkpoint anterior
Se um checkpoint anterior falhou na CI, no próximo pedido você recebe um **resumo barato**
da falha relevante. Corrija no código (se aplicável) e feche com um **novo checkpoint** —
sem polling, sem administrar Git. O merge fica bloqueado até ficar verde; isso não te
impede de seguir desenvolvendo.

### Auto-merge é do GitHub, não seu
O daemon empurra código; o GitHub valida os required checks do HEAD atual e só então
auto-mergeia na \`main\`. A segurança está nos gates automatizados — não há caminho para
ignorá-los, e você não precisa nem tentar.

Hooks de git, os required checks e a proteção da \`main\` são o enforcement independente:
se você ignorar estas instruções, eles reprovam. Você NÃO tem caminho para desativar
ruleset, remover checks, reduzir proteção, dar bypass ou force push.

## Banco de dados online (Supabase CLI)

Este checkout está **linkado ao Supabase remoto DESTE projeto** — o \`project-ref\`
fica em \`supabase/.temp/project-ref\`. Você opera o banco online direto pela CLI,
sem depender do MCP.

**Use SEMPRE a CLI local pinada do projeto: \`npx supabase …\`** (é uma
devDependency versionada, instalada pelo \`npm ci\`). Nunca use uma instalação
global — ela pode ter outra versão e dar comportamento diferente entre máquinas.

- **Sincronizar do remoto:** \`npx supabase db pull\` / \`npx supabase db diff\`
- **Mudar schema (tabela, coluna, RLS, policy, função SQL, trigger):**
  1. \`npx supabase migration new <nome>\` — cria a migration versionada
  2. escreva o SQL (toda tabela nova com RLS ativa + teste de isolamento)
  3. \`npx supabase db push\` — aplica no remoto
- **Edge Functions:** \`npx supabase functions new|deploy|list\`

**Migration é a fonte da verdade.** Nunca altere o schema "invisível" só no banco
(SQL solto no dashboard): mudança de schema/RLS vira migration versionada, validada
e aplicada por \`npx supabase db push\` no remoto linkado. Repositório e banco nunca
divergem. **Antes de QUALQUER mutação remota, confirme o alvo:**
\`cat supabase/.temp/project-ref\`.

### Operações destrutivas no remoto — PARE e confirme
\`npx supabase db reset --linked\`, \`DROP\`/\`TRUNCATE\` de estrutura existente,
\`DELETE\` em massa e exclusões massivas são irreversíveis no banco online. Antes
de rodar qualquer uma:
1. **Mostre o \`project-ref\` alvo:** \`cat supabase/.temp/project-ref\`.
2. **Peça confirmação explícita** ao humano, nomeando esse ref.
3. Só então execute. Nunca rode uma operação destrutiva de forma autônoma.

Credenciais (o token do \`supabase login\` e a senha do banco) vivem no **keychain
do sistema**, gravadas pela própria CLI. Nunca as imprima, escreva em arquivo nem
faça commit. O \`supabase/.temp/\` é gitignored — não versione o estado do link.

Este projeto é gerenciado pelo Supremo. O MCP remoto expõe estas regras via
\`get_project_context\` — elas valem de qualquer máquina.
`
}

function claudeMd(projectName: string): string {
  return `# CLAUDE.md — ${projectName}

Leia \`AGENTS.md\` primeiro — o **ciclo de desenvolvimento v3** está lá (regra
canônica). Este arquivo complementa e segue exatamente o mesmo contrato.

## Sempre
- Ler \`AGENTS.md\` e \`SECURITY.md\` antes de escrever código
- Seguir o **ciclo de desenvolvimento v3** do \`AGENTS.md\`
- Implementar do servidor para fora
- Ativar RLS em toda tabela nova **e escrever o teste de isolamento**
- Validar entrada com Zod no servidor
- Mudar o schema do banco online só por **migration versionada + \`npx supabase db
  push\`** (CLI local pinada, nunca a global; nunca SQL solto no dashboard). Ver
  "Banco de dados online" no \`AGENTS.md\`.
- Garantir o preview com **\`npm run preview:ensure\`** no início do pedido (persistente,
  HMR); **nunca** \`npm run dev\` à mão (mata o preview). Ver "Preview PERSISTENTE".
- **Rodar \`npm run verify\`** — comando padrão, adaptativo, **proporcional ao risco**
  (LOW só lint/typecheck do que mudou + testes relacionados; HIGH/SECURITY gates fortes).
  **Não** use lista fixa nem rode \`verify:full\` em toda microalteração — o pesado
  (build/suíte/RLS/CodeQL) roda em background/CI.
- Fechar cada pedido concluído com **\`npm run checkpoint -- "<resumo>"\`** (checkpoint
  LOCAL) e **devolver o controle imediatamente** — push/PR/CI/auto-merge são feitos pelo
  **checkpoint daemon** + Control Plane, em background
- **Continuar desenvolvendo enquanto o daemon integra em background** (é assíncrono)

## Nunca
- \`any\` no TypeScript
- \`console.log\` em produção
- Lógica de negócio em componente React
- Tabela sem RLS
- Segredo em código
- Validação de acesso no cliente
- **Rodar \`git push\`/\`git merge\`/\`git branch\`/\`git rebase\`/\`git push --force\` ou
  \`git commit\` de entrega** — você só faz \`checkpoint\` LOCAL; o daemon empurra
- **Abrir/atualizar PR, sincronizar com a \`main\` na mão, ou tratar corrida de
  auto-merge você mesmo** — o daemon rotaciona a branch e integra só o delta sozinho
- **Rodar \`npm run dev\` à mão** (mata o preview persistente) — use \`preview:ensure\`
- **"Melhorar" infra numa microfeature LOW** (AGENTS.md/CLAUDE.md/tsconfig/CI/package.json/
  migrations/config) sem necessidade técnica concreta — evite churn de infraestrutura
- **Esperar ou pollar a CI depois de um checkpoint** — é assíncrona; continue
- **Push direto na \`main\`; force push na \`main\`; bypass de required checks**
- **Desativar/comentar teste, afrouxar threshold, alterar ruleset ou remover gate para
  "ficar verde"** — corrija o código (ou o teste, se errado), nunca a barreira
- **Fazer merge por conta própria** — quem libera a \`main\` é o GitHub, só com todos os
  required checks do HEAD atual verdes (SHA verde antigo não libera SHA novo)
- Construir trabalho dependente sobre uma **falha crítica de segurança** sem corrigi-la
- Rodar destrutivo no remoto (\`npx supabase db reset --linked\`, \`DROP\`/\`TRUNCATE\`,
  \`DELETE\` em massa, reset/exclusão de dados) sem **confirmação explícita do humano** +
  mostrar o \`project-ref\` (auto-merge de código NÃO autoriza operação destrutiva)

## Commits
\`feat:\` \`fix:\` \`refactor:\` \`test:\` \`security:\` \`docs:\` \`chore:\`

Um commit por mudança lógica.

## Quando um gate falha
A CI é assíncrona — você descobre a falha na consulta rápida do INÍCIO do próximo
ciclo, não esperando por ela. Ao encontrar uma falha da revisão anterior: leia só o
erro necessário, corrija a causa, rode \`npm run verify\`, faça novo commit/push e
**deixe a CI seguir em background — não espere**. Falha crítica de segurança (RLS,
auth, tenant, migration, secret, IDOR, build) corrige-se ANTES de construir em cima.
Não desabilite o teste, não use \`skip\`, não afrouxe o threshold, não mexa no ruleset.
Se o gate está errado, corrija o gate legitimamente num commit separado e explique.
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
