import { describe, it, expect } from 'vitest'
import { buildProjectFiles, CI_INVOKED_SCRIPTS } from './project-files'
import { inferTablesFromMigration, generateRlsTest } from './rls-tests'

/**
 * Testes de coerência do template.
 *
 * Existem por causa de um bug real: o CI gerado rodava `npm run test` e
 * `npm run test:e2e`, que não existiam no package.json gerado, e o job de
 * build declarava `needs` nesses jobs. Todo projeto criado nascia com o CI
 * vermelho e nunca fazia deploy — e nada apontava isso.
 *
 * Estas asserções são o gate que impede a regressão.
 */

const files = buildProjectFiles({
  projectName: 'meu-app',
  description: 'App de teste',
})

function file(path: string): string {
  const entry = files.find((f) => f.path === path)
  if (!entry) {
    throw new Error(
      `Arquivo "${path}" não está no manifesto. Gerados: ${files
        .map((f) => f.path)
        .join(', ')}`,
    )
  }
  return entry.content
}

const packageJson = JSON.parse(file('package.json')) as {
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

describe('manifesto — integridade', () => {
  it('não gera caminhos duplicados', () => {
    const paths = files.map((f) => f.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('nenhum arquivo sai vazio', () => {
    const empty = files.filter((f) => f.content.trim().length === 0)
    expect(empty.map((f) => f.path)).toEqual([])
  })

  it('todo caminho é relativo e normalizado', () => {
    for (const entry of files) {
      expect(entry.path).not.toMatch(/^\//)
      expect(entry.path).not.toContain('..')
    }
  })
})

describe('CI — todo script invocado existe', () => {
  const ci = file('.github/workflows/ci.yml')

  it.each(CI_INVOKED_SCRIPTS)(
    'o script "%s" está declarado no package.json',
    (script) => {
      expect(Object.keys(packageJson.scripts)).toContain(script)
    },
  )

  it('todo `npm run X` do CI corresponde a um script declarado', () => {
    const invoked = [...ci.matchAll(/npm run ([\w:]+)/g)].map((m) => m[1])
    const declared = Object.keys(packageJson.scripts)

    const missing = invoked.filter(
      (script) => script && !declared.includes(script),
    )
    expect(missing).toEqual([])
  })

  it('o job de build só depende de jobs que existem', () => {
    const jobNames = [...ci.matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1])
    const needs = [...ci.matchAll(/needs:\s*\[([^\]]+)\]/g)].flatMap((m) =>
      (m[1] ?? '').split(',').map((n) => n.trim()),
    )

    const dangling = needs.filter((need) => !jobNames.includes(need))
    expect(dangling).toEqual([])
  })
})

describe('dependências — tudo que é importado está instalado', () => {
  const allDeps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  }

  it.each([
    ['vitest', 'vitest.config.ts'],
    ['@vitejs/plugin-react', 'vitest.config.ts'],
    ['@playwright/test', 'playwright.config.ts'],
    ['@testing-library/jest-dom', 'vitest.setup.ts'],
    ['@vitest/coverage-v8', 'vitest.config.ts'],
    ['@tailwindcss/postcss', 'postcss.config.mjs'],
  ])('%s está instalado (usado em %s)', (dependency) => {
    expect(Object.keys(allDeps)).toContain(dependency)
  })

  it('o config de cobertura exige um provider instalado', () => {
    expect(file('vitest.config.ts')).toContain("provider: 'v8'")
    expect(Object.keys(allDeps)).toContain('@vitest/coverage-v8')
  })

  it('não declara dependência de Tailwind v3 junto do v4', () => {
    expect(Object.keys(allDeps)).not.toContain('autoprefixer')
    expect(allDeps.tailwindcss).toMatch(/^\^4/)
  })
})

describe('migrations — nome que o CLI do Supabase aceita', () => {
  const migrations = files.filter((f) =>
    f.path.startsWith('supabase/migrations/'),
  )

  it('gera ao menos uma migration', () => {
    expect(migrations.length).toBeGreaterThan(0)
  })

  it('nenhuma usa nome reservado pelo CLI', () => {
    // O CLI pula migrations chamadas "init" — em silêncio, com um aviso que
    // some no meio do log:
    //   Skipping migration ..._init.sql (replace "init" with a different name)
    // O gate de RLS então acusava tabela inexistente, não falha de policy.
    const RESERVED = ['init']

    for (const migration of migrations) {
      const slug = migration.path
        .replace(/^supabase\/migrations\//, '')
        .replace(/^\d+_/, '')
        .replace(/\.sql$/, '')
      expect(RESERVED).not.toContain(slug)
    }
  })

  it('segue o padrão de nome versionado do CLI', () => {
    for (const migration of migrations) {
      expect(migration.path).toMatch(
        /^supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/,
      )
    }
  })
})

describe('dependabot — não propõe salto que quebra o projeto novo', () => {
  const config = file('.github/dependabot.yml')

  // Um projeto recém-criado recebeu na primeira semana um PR subindo o
  // TypeScript para 7.0, que o eslint-config-next ainda não suporta. O gate
  // barrou corretamente, mas o usuário vê um PR vermelho no dia um.
  it.each(['typescript', 'eslint-config-next', 'next', 'react'])(
    'ignora salto de versão maior de %s',
    (dependency) => {
      const block = config.slice(config.indexOf('ignore:'))
      expect(block).toContain(`dependency-name: ${dependency}`)
    },
  )

  it('continua propondo correções de patch e minor', () => {
    expect(config).toContain('interval: weekly')
    expect(config).toContain('version-update:semver-major')
    expect(config).not.toContain('version-update:semver-patch')
  })
})

describe('lockfile — sem ele o CI quebra antes de instalar', () => {
  // Bug real encontrado em produção: o CI gerado usava `npm ci` e
  // `cache: npm`, e ambos exigem lockfile. Sem ele, todo job falhava em
  // actions/setup-node antes de rodar uma linha do projeto.
  const lock = JSON.parse(file('package-lock.json')) as {
    name: string
    lockfileVersion: number
    packages: Record<string, { name?: string; version?: string }>
  }

  it('o manifesto inclui package-lock.json', () => {
    expect(() => file('package-lock.json')).not.toThrow()
  })

  it('o nome do lock bate com o do package.json', () => {
    expect(lock.name).toBe('meu-app')
    expect(lock.packages['']?.name).toBe('meu-app')
  })

  it('o .gitignore não exclui o lockfile', () => {
    const ignore = file('.gitignore')
      .split('\n')
      .map((l) => l.trim())
    expect(ignore).not.toContain('package-lock.json')
  })

  it('toda dependência do package.json está travada no lock', () => {
    const declared = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    }

    const missing = Object.keys(declared).filter(
      (name) => !(`node_modules/${name}` in lock.packages),
    )
    expect(missing).toEqual([])
  })

  it('o lock não trava pacote que o package.json não declara', () => {
    const declared = new Set([
      ...Object.keys(packageJson.dependencies),
      ...Object.keys(packageJson.devDependencies),
    ])
    const root = lock.packages[''] as unknown as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const inLock = new Set([
      ...Object.keys(root.dependencies ?? {}),
      ...Object.keys(root.devDependencies ?? {}),
    ])

    const extra = [...inLock].filter((name) => !declared.has(name))
    expect(extra).toEqual([])
  })
})

describe('CI — actions em versão suportada', () => {
  const ci = file('.github/workflows/ci.yml')

  it('não declara job de CodeQL — usa o default setup do GitHub', () => {
    // Um job de CodeQL próprio conflita com o default setup e falha em
    // repositório sem code scanning habilitado, pintando todo PR de
    // vermelho por motivo de plano, não de código.
    expect(ci).not.toMatch(/codeql-action/)
  })

  it('concede as permissões que os jobs realmente usam', () => {
    // gitleaks lê /pulls/N/commits; sem pull-requests: read recebe 403 e
    // o job falha sem ter escaneado nada — falso vermelho que treina a
    // equipe a ignorar o gate.
    expect(ci).toMatch(/pull-requests:\s*read/)
    expect(ci).toMatch(/security-events:\s*write/)
    expect(ci).toMatch(/contents:\s*read/)
  })

  it('não usa actions em depreciação de Node 20', () => {
    expect(ci).not.toMatch(/actions\/checkout@v4/)
    expect(ci).not.toMatch(/actions\/setup-node@v4/)
  })
})

describe('cobertura — o threshold falha o build', () => {
  it('define thresholds, não só reporter', () => {
    const config = file('vitest.config.ts')
    expect(config).toContain('thresholds')
    expect(config).toMatch(/lines:\s*\d+/)
  })
})

describe('segurança — o que o SECURITY.md promete existe', () => {
  it('gera next.config.ts', () => {
    expect(() => file('next.config.ts')).not.toThrow()
  })

  it('a CSP é real, não só mencionada', () => {
    const config = file('next.config.ts')
    expect(config).toContain('Content-Security-Policy')
    expect(config).toContain("default-src 'self'")
    expect(config).toContain("frame-ancestors 'none'")
  })

  it('produção bloqueia enquadramento, preview permite', () => {
    // O preview abre o app num iframe. Com frame-ancestors 'none' fixo, a
    // tela ficava em branco e parecia que o app não tinha subido.
    const config = file('next.config.ts')

    expect(config).toContain('isFramable')
    expect(config).toContain("VERCEL_ENV === 'preview'")
    // O deploy por envio de arquivos pode vir rotulado como produção; o
    // sinal explícito é o que garante o enquadramento no painel.
    expect(config).toContain("SUPREMO_PREVIEW === '1'")
    expect(config).toContain('frame-ancestors *')

    // X-Frame-Options não tem valor permissivo: precisa sair da lista,
    // senão anula o frame-ancestors da CSP.
    expect(config).toMatch(/isFramable \? \[\] : \[\{ key: 'X-Frame-Options'/)
  })

  it('o SECURITY.md aponta para o arquivo que de fato existe', () => {
    const doc = file('SECURITY.md')
    const referenced = doc.match(/`(next\.config\.[tj]s)`/)?.[1]
    if (referenced) {
      expect(() => file(referenced)).not.toThrow()
    }
  })

  it('a migration inicial ativa RLS em toda tabela criada', () => {
    const sql = file('supabase/migrations/00000000000000_initial_schema.sql')
    const created = [
      ...sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)/gi),
    ].map((m) => m[1])

    expect(created.length).toBeGreaterThan(0)

    for (const table of created) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
    }
  })

  it('nenhuma policy usa USING (true) ou WITH CHECK (true)', () => {
    // Comentários explicam justamente o que NÃO fazer; asserção sobre prosa
    // acusaria a própria documentação.
    const sql = file('supabase/migrations/00000000000000_initial_schema.sql')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n')

    expect(sql).not.toMatch(/USING\s*\(\s*true\s*\)/i)
    expect(sql).not.toMatch(/WITH CHECK\s*\(\s*true\s*\)/i)
  })

  it('o .gitignore cobre .env mas preserva o exemplo', () => {
    const ignore = file('.gitignore')
    expect(ignore).toContain('.env*')
    expect(ignore).toContain('!.env.example')
  })

  it('o .env.example não prefixa a service role com NEXT_PUBLIC_', () => {
    expect(file('.env.example')).not.toMatch(/NEXT_PUBLIC_SUPABASE_SERVICE/)
  })
})

describe('primeira tela — o app abre antes de configurar nada', () => {
  // Um projeto recém-criado não tem Supabase ligado. Sem guarda,
  // createServerClient estourava dentro do proxy e TODA requisição virava
  // 500 — o preview mostrava uma tela em branco e parecia que o app não
  // tinha subido.
  const proxyHelper = file('lib/supabase/middleware.ts')

  it('o proxy não estoura sem as variáveis do Supabase', () => {
    expect(proxyHelper).toContain('if (!supabaseUrl || !supabaseKey)')
    expect(proxyHelper).not.toContain('NEXT_PUBLIC_SUPABASE_URL!')
  })

  it('o starter não liga middleware antes de existir login', () => {
    // proxy.ts roda em todo request. Num projeto sem autenticação é peça a
    // mais, e no preview em navegador chegou a derrubar a aplicação.
    const paths = files.map((f) => f.path)
    expect(paths).not.toContain('proxy.ts')
    expect(paths).not.toContain('middleware.ts')
    expect(paths).toContain('lib/supabase/proxy.example.ts')
  })

  it('o cliente de navegador explica o que falta em vez de estourar cru', () => {
    const client = file('lib/supabase/client.ts')
    expect(client).toContain('Supabase não configurado')
    expect(client).toContain('.env.local')
  })

  it('a home não depende de dado remoto para renderizar', () => {
    const page = file('app/page.tsx')
    expect(page).not.toContain('createClient')
    expect(page).not.toContain('await ')
  })

  it('o preview roda com webpack, não com o bundler nativo', () => {
    // Turbopack é binário nativo e não executa dentro do WebContainer.
    expect(packageJson.scripts['dev:preview']).toBe('next dev --webpack')
  })
})

describe('E2E — o CI instala os motores que a suíte usa', () => {
  const ci = file('.github/workflows/ci.yml')
  const config = file('playwright.config.ts')

  // Bug real: o CI instalava só chromium, mas o projeto "mobile" usa
  // iPhone 14, que roda em WebKit. O job falhava com
  // "Executable doesn't exist at .../webkit-XXXX/pw_run.sh".
  const ENGINE_BY_DEVICE: Record<string, string> = {
    'Desktop Chrome': 'chromium',
    'Desktop Edge': 'chromium',
    'Pixel 7': 'chromium',
    'Desktop Safari': 'webkit',
    'iPhone 14': 'webkit',
    'iPad Pro 11': 'webkit',
    'Desktop Firefox': 'firefox',
  }

  const declaredDevices = [...config.matchAll(/devices\['([^']+)'\]/g)].map(
    (m) => m[1] as string,
  )

  it('declara ao menos um projeto de teste', () => {
    expect(declaredDevices.length).toBeGreaterThan(0)
  })

  it('todo motor exigido pelo config é instalado no CI', () => {
    const installLine = ci.match(/playwright install[^\n']*/)?.[0] ?? ''

    const required = new Set(
      declaredDevices
        .map((device) => ENGINE_BY_DEVICE[device])
        .filter((engine): engine is string => Boolean(engine)),
    )

    const missing = [...required].filter(
      (engine) => !installLine.includes(engine),
    )
    expect(missing).toEqual([])
  })
})

describe('E2E — o smoke test corresponde ao app gerado', () => {
  it('o título que o teste espera é o que o layout define', () => {
    const layout = file('app/layout.tsx')
    const spec = file('e2e/smoke.spec.ts')

    const layoutTitle = layout.match(/title:\s*'([^']+)'/)?.[1]
    expect(layoutTitle).toBe('meu-app')
    expect(spec).toContain(`toHaveTitle('${layoutTitle}')`)
  })

  it('o h1 que o teste procura existe na página', () => {
    expect(file('app/page.tsx')).toContain('meu-app')
    expect(file('e2e/smoke.spec.ts')).toContain('level: 1')
  })

  it('não sobrou o placeholder do create-next-app', () => {
    expect(file('e2e/smoke.spec.ts')).not.toContain('Create Next App')
  })
})

describe('test:rls — o filtro casa com o arquivo gerado', () => {
  // Bug real: o script filtrava `src/**/*.rls.test.ts`, mas o template não
  // tem diretório src/ — o teste de RLS fica em supabase/. O job passava
  // meses "verde" sem nunca ter rodado... na verdade falhava com
  // "No test files found", que é melhor, mas o gate mais importante do
  // template nunca exercitou nada.
  const rlsFiles = files.filter((f) => f.path.includes('.rls.test.'))

  it('o template gera ao menos um arquivo de teste de RLS', () => {
    expect(rlsFiles.length).toBeGreaterThan(0)
  })

  it('o filtro do script encontra os arquivos gerados', () => {
    const script = packageJson.scripts['test:rls'] ?? ''
    const filter = script.replace(/^vitest run\s*/, '').trim()

    expect(filter).not.toBe('')

    for (const rls of rlsFiles) {
      expect(
        rls.path.includes(filter),
        `"${filter}" não casa com "${rls.path}"`,
      ).toBe(true)
    }
  })

  it('a suíte normal exclui os testes de RLS', () => {
    // Eles precisam de Postgres real; rodar junto quebraria `npm test`.
    expect(packageJson.scripts.test).toContain('rls.test.ts')
    expect(packageJson.scripts.test).toContain('--exclude')
  })

  it('o padrão de exclusão casa com os arquivos gerados', () => {
    for (const rls of rlsFiles) {
      expect(rls.path.endsWith('.rls.test.ts')).toBe(true)
    }
  })
})

describe('geração de teste de RLS', () => {
  const sql = `
    CREATE TABLE posts (
      id UUID PRIMARY KEY,
      user_id UUID REFERENCES auth.users(id) NOT NULL,
      title TEXT NOT NULL
    );
    CREATE TABLE settings (
      id UUID PRIMARY KEY,
      key TEXT NOT NULL
    );
  `

  it('detecta tabela com coluna de dono', () => {
    const tables = inferTablesFromMigration(sql)
    expect(tables.map((t) => t.name)).toEqual(['posts'])
    expect(tables[0]?.ownerColumn).toBe('user_id')
  })

  it('ignora tabela sem dono — não há isolamento por linha a provar', () => {
    expect(inferTablesFromMigration(sql).map((t) => t.name)).not.toContain(
      'settings',
    )
  })

  it('detecta colunas NOT NULL para semear a linha de teste', () => {
    const [posts] = inferTablesFromMigration(sql)
    expect(posts?.requiredColumns?.map((c) => c.name)).toContain('title')
  })

  it('o teste gerado cobre as cinco provas de isolamento', () => {
    const generated = generateRlsTest(inferTablesFromMigration(sql))

    expect(generated).toContain('o dono lê a própria linha')
    expect(generated).toContain('outro usuário autenticado NÃO lê a linha')
    expect(generated).toContain('a anon key NÃO lê a linha')
    expect(generated).toContain('outro usuário NÃO consegue atualizar a linha')
    expect(generated).toContain('outro usuário NÃO consegue deletar a linha')
  })

  it('o template já inclui o teste de RLS da tabela inicial', () => {
    expect(file('supabase/rls.rls.test.ts')).toContain(
      "describe('RLS · profiles'",
    )
  })

  it('o CI tem um job que roda os testes de RLS', () => {
    const ci = file('.github/workflows/ci.yml')
    expect(ci).toContain('npm run test:rls')
    expect(ci).toContain('supabase/setup-cli')
  })
})

describe('documentação — sem promessa vazia', () => {
  it('o README só cita comandos que existem', () => {
    const readme = file('README.md')
    const cited = [...readme.matchAll(/`npm run ([\w:]+)`/g)].map((m) => m[1])
    const declared = Object.keys(packageJson.scripts)

    const missing = cited.filter(
      (script) => script && !declared.includes(script),
    )
    expect(missing).toEqual([])
  })

  it('gera as regras que o MCP lê remotamente', () => {
    expect(() => file('agents.md')).not.toThrow()
    expect(() => file('CLAUDE.md')).not.toThrow()
    expect(() => file('SECURITY.md')).not.toThrow()
  })
})
