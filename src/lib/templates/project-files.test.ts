import { describe, it, expect } from 'vitest'
import {
  CI_JOB_NAMES,
  buildProjectFiles,
  CI_INVOKED_SCRIPTS,
  TEMPLATE_VERSION,
  GITLEAKS_VERSION,
  GITLEAKS_SHA256_LINUX_X64,
} from './project-files'
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

/**
 * Colapsa espaços/quebras de linha em um só espaço. Os textos gerados (AGENTS.md/
 * CLAUDE.md) quebram linha por largura (~80 colunas) na fonte, então checar uma
 * frase exata sem isso é frágil — um reflow trivial no texto-fonte (sem mudar o
 * conteúdo) quebraria o teste por um motivo alheio ao que ele verifica.
 */
function norm(s: string): string {
  return s.replace(/\s+/g, ' ')
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

describe('login no preview — cookie de terceira-parte no iframe', () => {
  // Sem Partitioned (CHIPS), o Chrome descarta o cookie de sessão no iframe
  // mesmo com SameSite=None, e o login volta para /login. Os três lugares que
  // escrevem cookie precisam do conjunto completo.
  for (const path of [
    'proxy.ts',
    'lib/supabase/client.ts',
    'lib/supabase/server.ts',
  ]) {
    it(`${path} usa SameSite=None; Secure; Partitioned no preview`, () => {
      const content = file(path)
      expect(content).toContain("sameSite: 'none'")
      expect(content).toContain('secure: true')
      expect(content).toContain('partitioned: true')
    })
  }
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

describe('dependabot — v3.3.0: sem version-update PRs por padrão (não gera fila de manutenção)', () => {
  // Um projeto recém-criado ganhava SEIS PRs automáticos do Dependabot em
  // minutos — o usuário não pediu isso. npm audit (job "dependencies") e os
  // alertas nativos de segurança do GitHub continuam cobrindo vulnerabilidade
  // real, sem o arquivo.
  it('NÃO gera .github/dependabot.yml', () => {
    expect(files.map((f) => f.path)).not.toContain('.github/dependabot.yml')
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
    expect(ci).toMatch(/security-events:\s*write/)
    expect(ci).toMatch(/contents:\s*read/)
  })

  it('o workflow (nível raiz) NÃO concede pull-requests:read — só o job "changes" precisa (ver describe dedicado abaixo)', () => {
    // v3.3.0: trocamos gitleaks/gitleaks-action (que lia /pulls/N/commits) pela
    // CLI oficial rodando sobre `fetch-depth: 0` — gitleaks nunca chama a API
    // de PR, então esse gate continua certo em não precisar da permissão.
    // dorny/paths-filter (job "changes") passou a precisar dela (E2E real:
    // "Resource not accessible by integration") — mas concedida SÓ nesse job,
    // nunca no bloco `permissions:` do topo do arquivo (que os outros 7 jobs
    // herdam) — menor privilégio.
    const topLevelPermissions = ci.slice(0, ci.indexOf('\njobs:'))
    expect(topLevelPermissions).not.toMatch(/pull-requests:\s*read/)
  })

  it('não usa actions em depreciação de Node 20', () => {
    expect(ci).not.toMatch(/actions\/checkout@v4/)
    expect(ci).not.toMatch(/actions\/setup-node@v4/)
  })

  it('roda em Node 22, e o .nvmrc concorda com o CI', () => {
    // Bug real da natureza: com Node 20, o Dependabot subiu jsdom para a v30
    // (que exige Node 22+), os testes não iniciavam e a cobertura ia a 0%.
    // Node 22 é o LTS ativo e resolve essa classe de quebra.
    expect(ci).toMatch(/node-version:\s*'22'/)
    expect(ci).not.toMatch(/node-version:\s*'20'/)
    expect(file('.nvmrc').trim()).toBe('22')
  })
})

/**
 * E2E real: dorny/paths-filter@v3 falhou em PR com "Resource not accessible
 * by integration" ao buscar os arquivos mudados. Num evento pull_request, o
 * checkout não traz histórico da base (fetch-depth padrão) — a action então
 * cai pro fallback via API do GitHub (lista os arquivos da PR), que exige
 * `pull-requests: read` no GITHUB_TOKEN. Sem essa permissão, a chamada falha
 * com exatamente esse erro. Fix: concede a permissão MÍNIMA necessária — só
 * no job "changes" (onde paths-filter roda), nunca no workflow inteiro.
 */
describe('CI — permissões mínimas do job "changes" (dorny/paths-filter precisa ler a PR)', () => {
  const ci = file('.github/workflows/ci.yml')
  const changesJob = ci.slice(ci.indexOf('\n  changes:'), ci.indexOf('\n  quality:'))

  it('o job "changes" concede pull-requests:read — a permissão que faltava no E2E real', () => {
    expect(changesJob).toMatch(/permissions:\s*\n\s*contents:\s*read\s*\n\s*pull-requests:\s*read/)
  })

  it('a permissão é escopada SÓ ao job "changes" — os outros 7 jobs não ganham acesso de leitura à PR', () => {
    const otherJobs = ci.slice(ci.indexOf('\n  quality:'))
    expect(otherJobs).not.toMatch(/pull-requests:\s*read/)
  })

  it('o job "changes" não herda permissões que não usa (security-events/actions) — um job com `permissions:` próprio substitui, não soma, o bloco do workflow', () => {
    // Documenta a semântica do GitHub Actions que este fix depende: definir
    // `permissions:` num job REESCREVE (não estende) o que ele herdaria do
    // topo do arquivo — por isso listar só contents+pull-requests aqui é
    // estritamente MENOS, não mais, do que o job tinha antes (que herdava
    // também security-events:write e actions:read, que paths-filter/checkout
    // nunca usam).
    expect(changesJob).not.toMatch(/security-events/)
    expect(changesJob).not.toMatch(/actions:\s*read/)
  })

  it('dorny/paths-filter continua no job "changes", depois do checkout', () => {
    expect(changesJob).toMatch(/uses:\s*actions\/checkout@v5/)
    expect(changesJob).toMatch(/uses:\s*dorny\/paths-filter@v3/)
    // Busca o PASSO (`uses: ...`), não uma menção em comentário explicativo
    // (o comentário acima de `permissions:` cita dorny/paths-filter@v3 na
    // prosa, antes do passo de verdade).
    expect(changesJob.indexOf('uses: actions/checkout@v5')).toBeLessThan(
      changesJob.indexOf('uses: dorny/paths-filter@v3'),
    )
  })
})

describe('gitleaks — CLI oficial pinada, scaffold nasce verde sem licença', () => {
  const ci = file('.github/workflows/ci.yml')

  it('NÃO usa a Action (exige GITLEAKS_LICENSE mesmo em repo privado de Organization)', () => {
    // O nome da Action pode aparecer num COMENTÁRIO explicando a troca; o que
    // não pode existir é um passo `uses:` rodando-a, nem exigir a env da licença.
    expect(ci).not.toMatch(/uses:\s*gitleaks\/gitleaks-action/)
    expect(ci).not.toMatch(/GITLEAKS_LICENSE\s*:/) // nunca referenciada como env/secret
  })

  it('baixa a CLI oficial pinada por versão E confere o checksum antes de rodar', () => {
    expect(ci).toContain(`gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/`)
    expect(ci).toContain(GITLEAKS_SHA256_LINUX_X64)
    expect(ci).toMatch(/sha256sum -c/)
  })

  it('roda `gitleaks detect` e falha de verdade se achar segredo (--exit-code 1)', () => {
    expect(ci).toMatch(/\.\/gitleaks detect/)
    expect(ci).toMatch(/--exit-code 1/)
  })

  it('não exige nenhum secret manual (nenhuma referência a secrets.GITLEAKS)', () => {
    expect(ci).not.toMatch(/secrets\.GITLEAKS/i)
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

  it('a CSP é real, e vive onde o nonce pode existir', () => {
    // Cabeçalho de next.config é estático, e nonce precisa mudar a cada
    // requisição. Enquanto a CSP morava lá, a política de scripts era
    // 'unsafe-inline' — ou seja, autorizava exatamente o que um XSS injeta.
    const proxy = file('proxy.ts')
    expect(proxy).toContain('Content-Security-Policy')
    expect(proxy).toContain("default-src 'self'")
    expect(proxy).toContain("'strict-dynamic'")
    expect(proxy).toContain("'nonce-")
    expect(proxy).toContain('x-nonce')

    // Duas CSPs no mesmo response se somam pela regra mais restritiva e viram
    // bloqueio difícil de diagnosticar.
    expect(file('next.config.ts')).not.toMatch(/key: 'Content-Security-Policy'/)
  })

  it('nenhum script inline é autorizado por origem', () => {
    const proxy = file('proxy.ts')
    const scriptSrc = /script-src[^`]*/.exec(proxy)?.[0] ?? ''
    expect(scriptSrc).toContain("'strict-dynamic'")
    // 'strict-dynamic' anula 'self' e 'unsafe-inline' em qualquer navegador
    // que o entenda; o inline fica só como plano B para navegador antigo.
    expect(scriptSrc).not.toMatch(/script-src 'self' 'unsafe-inline'/)
  })

  it('só o Supremo pode enquadrar, nunca a internet inteira', () => {
    // Era `frame-ancestors *`. Bastava SUPREMO_PREVIEW aparecer num deploy de
    // produção — copiada junto com as outras variáveis — para a aplicação
    // virar alvo aberto de clickjacking.
    const proxy = file('proxy.ts')
    expect(proxy).not.toContain('frame-ancestors *')
    expect(proxy).toMatch(/frame-ancestors 'self' \$\{/)
    expect(proxy).toContain('SUPREMO_ORIGIN')
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

  it('o .gitignore ignora o estado do link do Supabase (supabase/.temp)', () => {
    const ignore = file('.gitignore')
    expect(ignore).toContain('supabase/.temp/')
  })
})

describe('banco online — regras do agente para o Supabase via CLI', () => {
  it('AGENTS.md ensina o fluxo de migration como fonte da verdade', () => {
    const agents = file('AGENTS.md')
    expect(agents).toContain('Banco de dados online')
    expect(agents).toContain('supabase migration new')
    expect(agents).toContain('supabase db push')
    expect(agents).toContain('supabase/.temp/project-ref')
  })

  it('AGENTS.md exige confirmação + ref antes de operação destrutiva remota', () => {
    const agents = file('AGENTS.md')
    expect(agents).toMatch(/destrutiv/i)
    expect(agents).toContain('supabase db reset')
    expect(agents).toContain('confirmação explícita')
  })

  it('CLAUDE.md proíbe destrutivo no remoto sem confirmação', () => {
    const claude = file('CLAUDE.md')
    expect(claude).toContain('supabase db reset')
    expect(claude).toMatch(/project-ref/)
  })

  it('config.toml nasce no Postgres 17 (casa com o default do Supabase)', () => {
    const cfg = file('supabase/config.toml')
    expect(cfg).toMatch(/major_version\s*=\s*17/)
    expect(cfg).not.toMatch(/major_version\s*=\s*15/)
  })

  it('a Supabase CLI é devDependency PINADA (sem depender de global)', () => {
    const supabase = packageJson.devDependencies.supabase
    expect(supabase).toBeTruthy()
    // pinada exata (sem ^ ou ~) para a mesma versão em toda máquina
    expect(supabase).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('AGENTS.md manda usar a CLI local (npx supabase), não a global', () => {
    expect(file('AGENTS.md')).toContain('npx supabase')
    expect(file('CLAUDE.md')).toContain('npx supabase')
  })
})

describe('workflow v3.1 — preview persistente + fast dev loop', () => {
  const paths = files.map((f) => f.path)
  const pkg = JSON.parse(file('package.json')) as { scripts: Record<string, string> }
  const agents = file('AGENTS.md')
  const claude = file('CLAUDE.md')

  it('gera o supervisor de preview (scripts/preview.mjs)', () => {
    expect(paths).toContain('scripts/preview.mjs')
  })

  it('package.json expõe preview:ensure/status/stop', () => {
    expect(pkg.scripts['preview:ensure']).toBe('node scripts/preview.mjs ensure')
    expect(pkg.scripts['preview:status']).toBe('node scripts/preview.mjs status')
    expect(pkg.scripts['preview:stop']).toBe('node scripts/preview.mjs stop')
  })

  it('.gitignore ignora o estado por-máquina do preview (não versiona pid/porta/log)', () => {
    const ignore = file('.gitignore')
    expect(ignore).toContain('.supremo/preview.pid')
    expect(ignore).toContain('.supremo/preview.port')
    expect(ignore).toContain('.supremo/preview.log')
  })

  it('AGENTS.md menciona preview:ensure (como fallback — ver describe dedicado) e proíbe npm run dev à mão', () => {
    expect(agents).toContain('preview:ensure')
    expect(agents).toMatch(/NUNCA.*npm run dev|npm run dev.*mata o preview/i)
  })

  it('AGENTS.md/CLAUDE.md: NENHUMA regra manda rodar preview:ensure obrigatoriamente no início de todo pedido/sessão', () => {
    // Bug real corrigido: a versão anterior dizia simultaneamente "no início de
    // todo pedido, rode preview:ensure" E "reutilize .supremo/preview.port sem
    // subir outro servidor" — contraditório. preview:ensure agora é SÓ o
    // fallback (arquivo ausente), nunca a primeira ação obrigatória.
    for (const doc of [norm(agents), norm(claude)]) {
      expect(doc).not.toMatch(/no início de todo pedido, garanta o preview/i)
      expect(doc).not.toMatch(/garantir o preview com.*preview:ensure.*no início do pedido/i)
      expect(doc).not.toMatch(/preview:ensure.*—\s*garante o preview persistente \(reusa se vivo/i)
    }
  })

  it('AGENTS.md define hot path por risco (LOW/MEDIUM/HIGH; pesado em background)', () => {
    expect(agents).toMatch(/\bLOW\b/)
    expect(agents).toMatch(/HIGH\/SECURITY|HIGH/)
    expect(agents).toMatch(/background/i)
  })

  it('AGENTS.md proíbe churn de infra em microfeature (não mexer em tsconfig/CI/etc.)', () => {
    expect(agents).toMatch(/tsconfig/)
    expect(agents).toMatch(/microfeature|microaltera/i)
  })

  it('CLAUDE.md segue o mesmo contrato (preview:ensure)', () => {
    expect(claude).toContain('preview:ensure')
  })
})

describe('workflow v3.1 item 4 — checkpoint/push silencioso (daemon)', () => {
  const pkg = JSON.parse(file('package.json')) as { scripts: Record<string, string> }
  const agents = file('AGENTS.md')
  const claude = file('CLAUDE.md')
  const projectJson = JSON.parse(file('.supremo/project.json')) as Record<string, unknown>

  it('template >= 3.2.0 (checkpoint daemon)', () => {
    expect(TEMPLATE_VERSION >= '3.2.0').toBe(true)
  })

  it('package.json expõe checkpoint + daemon:ensure/status/stop (via CLI)', () => {
    expect(pkg.scripts.checkpoint).toMatch(/supremo-cli checkpoint/)
    expect(pkg.scripts['daemon:ensure']).toMatch(/daemon --ensure/)
    expect(pkg.scripts['daemon:status']).toMatch(/daemon --status/)
    expect(pkg.scripts['daemon:stop']).toMatch(/daemon --stop/)
  })

  it('.gitignore ignora o estado por-máquina do daemon (fila/pid/log/worktree)', () => {
    expect(file('.gitignore')).toContain('.supremo/checkpoints/')
  })

  it('.supremo/project.json carrega a URL do Supremo para o daemon chamar', () => {
    expect(typeof projectJson.supremoUrl).toBe('string')
    expect(String(projectJson.supremoUrl)).toMatch(/^https?:\/\//)
  })

  // teste 14 — o agente NUNCA executa git push; fecha o pedido com checkpoint LOCAL
  it('AGENTS.md: fecha o pedido com checkpoint LOCAL e proíbe git push/branch/PR', () => {
    expect(agents).toMatch(/npm run checkpoint|supremo checkpoint/)
    expect(agents).toMatch(/NUNCA[\s\S]{0,60}git push/i)
    expect(agents).toMatch(/git branch|git checkout -b/)
    expect(agents).toMatch(/abra\/atualize\/feche PR/i)
  })

  // teste 20 — o contrato vale para Codex e Claude (AGENTS canônico + CLAUDE alinhado)
  it('o contrato do checkpoint vale para Codex e Claude', () => {
    // AGENTS.md é o contrato canônico que os DOIS agentes leem
    expect(agents).toMatch(/checkpoint/i)
    expect(claude).toMatch(/checkpoint/i)
    expect(claude).toMatch(/AGENTS\.md/)
    // ambos proíbem git push manual (o daemon é quem empurra)
    expect(claude).toMatch(/git push/)
  })
})

describe('finalização v3.1 — browser integrado × QA visual, checkpoint 100% offline', () => {
  const agents = file('AGENTS.md')
  const claude = file('CLAUDE.md')

  it('regra canônica: preview é do usuário, validação de código é do agente', () => {
    expect(agents).toMatch(/preview pertence ao usuário/i)
    expect(agents).toMatch(/validação automatizada pertence\s+a você/i)
  })

  it('proíbe QA visual manual por padrão (clicar/navegar/tour), permite exceções explícitas', () => {
    expect(agents).toMatch(/NÃO DEVE, por padrão/)
    expect(agents).toMatch(/mover o mouse|clicar em botão|preencher formulário/)
    expect(agents).toMatch(/usuário pedir explicitamente/i)
    expect(claude).toMatch(/QA visual manual/i)
  })

  it('disponibilizar o preview (browser integrado) continua desejável', () => {
    expect(agents).toMatch(/disponibilize automaticamente o preview|disponibilize-o automaticamente/i)
    expect(claude).toMatch(/disponibilizar automaticamente o\s*\n?\s*preview/i)
  })

  it('checkpoint local nunca depende de SUPREMO_URL/rede; erro nesse sentido = CLI desatualizada', () => {
    expect(agents).toMatch(/nunca depende de rede/i)
    expect(agents).toMatch(/modo avião/i)
    expect(agents).toMatch(/SUPREMO_URL/)
    expect(agents).toMatch(/não\*\*\s*\n?tente configurar nada nem exportar variável/i)
  })
})

/**
 * E2E: quando o bootstrap já subiu um preview persistente, o agente deve
 * REUTILIZAR essa URL (nunca subir outro servidor) e — se o host tiver um
 * browser/preview pane integrado — abrir/disponibilizar esse preview pro
 * usuário automaticamente, sem que ele precise pedir, no início da sessão
 * ou do primeiro pedido. Sem pane integrado, só informar a URL real. Nunca
 * QA visual/navegação/cliques automáticos — isso já é coberto pelo describe
 * "browser integrado × QA visual" acima; aqui o foco é especificamente a
 * REUTILIZAÇÃO da URL persistida e a abertura PROATIVA (sem pedido).
 */
describe('preview persistente — reutiliza URL real e abre proativamente (bootstrap já iniciou)', () => {
  // norm() colapsa quebra de linha por largura — ver comentário no helper.
  const agents = norm(file('AGENTS.md'))
  const claude = norm(file('CLAUDE.md'))

  it('AGENTS.md: a URL real vem de .supremo/preview.port — nunca assume localhost:3000 de cabeça (porta pode ter sido relocada)', () => {
    expect(agents).toContain('.supremo/preview.port')
    expect(agents).toMatch(/[Nn]unca\*{0,2} assuma `?localhost:3000`? de cabeça/)
  })

  it('AGENTS.md: reutiliza a URL real quando o preview está de pé, NUNCA sobe outro servidor no sandbox (v3.2 — health-based, não só existência do arquivo)', () => {
    expect(agents).toContain('reutilize essa URL direto')
    expect(agents).toContain('não tente subir outro servidor dentro do sandbox')
  })

  it('AGENTS.md: v3.2 — a existência de `.supremo/preview.port` NÃO prova saúde (reboot mata o processo, não o arquivo)', () => {
    expect(agents).toMatch(/[Nn]unca (trate como saudável|confie só na exist[êe]ncia do arquivo)/)
    expect(agents).toContain('a existência do arquivo prova que já rodou uma vez, não que está de pé agora')
  })

  it('AGENTS.md: passo 1 do fluxo normal roda o preflight (não decide reutilizar/ensure sozinho) — antes de TODO pedido, não só o primeiro (v3.4)', () => {
    expect(agents).toContain('**Preflight**: rode `npm run supremo:resume`')
    expect(agents).toContain('ver "Retomada automática de sessão"')
    expect(agents).toMatch(/Todo pedido que muda código, não só o primeiro/)
  })

  it('AGENTS.md: abre/disponibiliza o preview automaticamente no início da sessão/primeiro pedido, sem o usuário pedir', () => {
    expect(agents).toMatch(/[Nn]o início da sessão ou do primeiro pedido/)
    expect(agents).toContain('sem que o usuário precise pedir')
  })

  it('AGENTS.md: sem pane integrado → só informa a URL real, nunca tenta abrir navegador por conta própria', () => {
    expect(agents).toContain('tiver um pane integrado, apenas **informe essa URL real**')
    expect(agents).toContain('não tente abrir navegador nenhum por conta própria')
  })

  it('AGENTS.md: abrir/disponibilizar o preview não é "navegar" — as regras de não fazer QA visual continuam valendo depois', () => {
    expect(agents).toMatch(/não é "navegar"/)
  })

  it('AGENTS.md: HMR reflete as mudanças seguintes no MESMO preview (não recria a cada prompt)', () => {
    expect(agents).toMatch(/HMR reflete as mudanças no mesmo servidor/i)
    expect(agents).toContain('Não mate/recrie o preview a cada prompt')
  })

  it('AGENTS.md: preview:status já devolve a URL certa (fonte alternativa à leitura direta do arquivo)', () => {
    expect(agents).toMatch(/preview:status[\s\S]*devolve a URL certa/)
  })

  it('CLAUDE.md: v3.4 — preflight roda antes de TODO pedido; nunca confia só na existência do arquivo de preview', () => {
    expect(claude).toContain('.supremo/preview.port')
    expect(claude).toContain('npm run supremo:resume')
    expect(claude).toMatch(/Antes de todo pedido que muda código/)
    expect(claude).toMatch(/\*\*Nunca\*\* confie só na existência de/)
    expect(claude).toContain('nunca** suba outro servidor no sandbox')
  })

  it('CLAUDE.md: abre/disponibiliza automaticamente no início da sessão/primeiro pedido, sem pedido do usuário', () => {
    expect(claude).toMatch(/início da sessão\/primeiro pedido/)
    expect(claude).toContain('sem que ele precise pedir')
  })

  it('CLAUDE.md: sem pane integrado, só informa a URL', () => {
    expect(claude).toContain('Sem pane integrado, apenas informe essa URL')
  })

  it('AGENTS.md/CLAUDE.md: NENHUMA instrução manda rodar preview:ensure incondicionalmente no início de todo pedido/sessão — a contradição real do E2E', () => {
    // Frase EXATA que existia antes e contradizia "reutilize .supremo/preview.port":
    // "No início de todo pedido, garanta o preview com npm run preview:ensure."
    for (const doc of [agents, claude]) {
      expect(doc).not.toContain('No início de todo pedido, garanta o preview')
      expect(doc).not.toMatch(/garanta o preview com \*\*`npm run preview:ensure`\*\*/)
      expect(doc).not.toMatch(/Garantir o preview com \*\*`npm run preview:ensure`\*\* no início do pedido/)
    }
  })
})

/**
 * Retomada automática de sessão (v3.2) — E2E real: depois de fechar/reabrir o
 * agente (ou reiniciar a máquina), o usuário nunca deveria precisar rodar
 * bootstrap de novo. Estes testes cobrem a POLÍTICA que o agente lê (o
 * comportamento de verdade — daemon/preview vivos vs. mortos, porta
 * persistida, sem bootstrap/build/teste no meio do caminho — é provado em
 * harness.test.ts, com o script `supremo-status.mjs --ensure` executado de
 * verdade, e no smoke real de `packages/cli`).
 */
describe('retomada automática de sessão (v3.2) — nunca precisa de bootstrap de novo', () => {
  const agents = norm(file('AGENTS.md'))
  const claude = norm(file('CLAUDE.md'))
  const pkg = JSON.parse(file('package.json')) as { scripts: Record<string, string> }

  it('package.json expõe supremo:resume — a mesma rota que o supremo:status, com --ensure', () => {
    expect(pkg.scripts['supremo:resume']).toBe('node scripts/supremo-status.mjs --ensure')
  })

  it('AGENTS.md: antes de TODO pedido que muda código (não só o primeiro — o host pode restaurar a mesma sessão), roda supremo:resume (v3.4)', () => {
    expect(agents).toMatch(/antes de QUALQUER pedido que vá alterar código/i)
    expect(agents).toContain('npm run supremo:resume')
    expect(agents).toMatch(/host pode restaurar a MESMA conversa/)
  })

  it('AGENTS.md: NUNCA roda bootstrap de novo numa máquina onde ele já rodou', () => {
    expect(agents).toMatch(/NUNCA\*{0,2} rode bootstrap de novo numa máquina onde ele já rodou/)
    expect(agents).toContain('sem nova autorização')
  })

  it('AGENTS.md: a retomada é LEVE — nunca inclui bootstrap/build/testes/install/relink/reautenticação', () => {
    expect(agents).toMatch(/LEVE e RÁPIDA/)
    expect(agents).toContain('rodar bootstrap de novo')
    expect(agents).toContain('`build`')
    expect(agents).toContain('a suíte de testes')
    expect(agents).toMatch(/npm install.{0,20}religar dependências/)
    expect(agents).toContain('relinkar o Supabase')
    expect(agents).toContain('refazer qualquer autenticação')
  })

  it('AGENTS.md: NÃO existe mais regra de "só primeiro pedido" — supremo:resume roda antes de TODO pedido, custo próximo de zero quando saudável (v3.4)', () => {
    expect(agents).toMatch(/[Rr]oda antes de todo pedido que muda código — nunca só uma vez por sessão/)
    expect(agents).toMatch(/[Nn]ão existe mais uma regra de "primeiro pedido"/)
    expect(agents).toContain('custo no caminho saudável é próximo de zero')
  })

  it('AGENTS.md: cobre tanto preview quanto daemon — vivo reutiliza, morto religa pelo mecanismo já existente', () => {
    expect(agents).toContain('preview saudável')
    expect(agents).toContain('preview registrado mas morto')
    expect(agents).toMatch(/\*\*daemon\*\*.{0,60}vivo reutiliza, morto religa/)
  })

  it('AGENTS.md: existência de .supremo/preview.port NUNCA é tratada como prova de saúde (o gap real do reboot)', () => {
    expect(agents).toContain(
      'a existência do arquivo prova que já rodou uma vez, não que está de pé agora',
    )
  })

  it('CLAUDE.md segue o mesmo contrato: supremo:resume roda antes de TODO pedido, sem bootstrap/build/testes/reauth (v3.4)', () => {
    expect(claude).toContain('npm run supremo:resume')
    expect(claude).toMatch(/Antes de todo pedido que muda código.{0,60}nunca só "no primeiro"/i)
    expect(claude).toContain('sem** bootstrap, build, testes, install, relink ou reautenticação')
    expect(claude).toContain('Rodar bootstrap de novo numa máquina onde ele já rodou')
  })
})

/**
 * Sincronização entre máquinas (v3.3) — E2E real: "máquina A: A→B→C; máquina
 * B está parada em A; abre B, manda um prompt; Supremo faz uma checagem
 * rápida, percebe remoto C, atualiza A→C automaticamente se o worktree
 * estiver limpo". Estes testes cobrem a POLÍTICA que o agente lê (item 6:
 * nenhuma consulta remota a cada prompt — só o agente sabe se é o primeiro
 * pedido, então só dá pra garantir por regra textual). O comportamento de
 * verdade (fast-forward seguro, nunca sobrescreve, timeout curto, proteção
 * cross-machine no publish) é provado com git/HTTP reais em
 * packages/cli/src/sync*.test.ts e src/lib/checkpoint/integration.test.ts.
 */
describe('sincronização entre máquinas (v3.3) — sem git pull manual, sem polling a cada prompt', () => {
  const agents = norm(file('AGENTS.md'))
  const claude = norm(file('CLAUDE.md'))
  const pkg = JSON.parse(file('package.json')) as { scripts: Record<string, string> }

  it('package.json expõe sync (mesma rota de npx do checkpoint/daemon)', () => {
    expect(pkg.scripts.sync).toBe('npx --yes supremo-cli sync')
  })

  it('AGENTS.md: sync mantém regra PRÓPRIA de só primeiro pedido — independente do supremo:resume, que agora roda todo pedido (v3.4)', () => {
    expect(agents).toMatch(/[Ss]ó no primeiro pedido da sessão.{0,40}regra PRÓPRIA do `?sync`?/)
    expect(agents).toMatch(/`?supremo:resume`? acima.{0,20}que agora roda antes de todo pedido/)
    expect(agents).toContain('npm run sync')
  })

  it('AGENTS.md: item 6 — NUNCA roda sync fora do primeiro pedido (nenhuma consulta remota a cada prompt)', () => {
    expect(agents).toMatch(/NUNCA\*{0,2} rode `?npm run sync`? fora do primeiro pedido da sessão/)
    expect(agents).toContain('nenhuma consulta remota a cada prompt')
  })

  it('AGENTS.md: checagem LEVE — timeout curto, nunca GitHub', () => {
    expect(agents).toMatch(/checagem LEVE/)
    expect(agents).toMatch(/timeout curto/)
    expect(agents).toContain('nunca ao GitHub')
  })

  it('AGENTS.md: reconhece checkpoint publicado ainda em PR/CI (não só origin/main) — o gap real do pedido', () => {
    expect(agents).toContain('um checkpoint que outra máquina já publicou mas')
    expect(agents).toMatch(/ainda está em PR\/CI também conta como "mais novo"/)
  })

  /**
   * Ajuste explícito: a continuidade de edição entre as PRÓPRIAS máquinas do
   * usuário nunca espera o checkpoint integrar em main — só precisa já ter
   * sido publicado com sucesso pelo Supremo (uma branch real). CI continua
   * obrigatório só pra MERGE em main.
   */
  it('AGENTS.md: continuidade entre máquinas NUNCA espera o CI — só precisa estar publicado (branch real), nunca "integrado"', () => {
    expect(agents).toMatch(/continuidade de edição entre suas máquinas nunca espera o CI terminar/)
    expect(agents).toContain('já foi publicado com sucesso pelo Supremo')
    expect(agents).toMatch(/CI continua\s*\*{0,2}obrigatório\*{0,2} pra qualquer merge em `?main`?/)
    // nunca mais restrito à main/integrado — published+integration_branch já basta
    expect(agents).not.toMatch(/sincroniza sozinho por fast-forward seguro[\s\S]{0,10}remoto já integrado/)
  })

  it('AGENTS.md: exemplo explícito do pedido — A local, C publicado com CI rodando → sincroniza pra C, continua C→D', () => {
    expect(agents).toMatch(/checkpoints A→B→C; C já foi publicado com sucesso/)
    expect(agents).toContain('o CI de C ainda está rodando')
    expect(agents).toMatch(/sincroniza direto pra C \(a branch de integração dele, não `?main`? — C ainda não integrou\)/)
    expect(agents).toContain('sem esperar o CI de C terminar')
  })

  it('AGENTS.md: fast-forward só quando limpo e seguro — NUNCA reset/force', () => {
    expect(agents).toMatch(/worktree limpo/)
    expect(agents).toContain('fast-forward seguro')
    expect(agents).toContain('**nunca** reset, **nunca** force')
  })

  it('AGENTS.md: alterações locais não checkpointadas NUNCA são sobrescritas', () => {
    expect(agents).toMatch(/\*\*nunca\*\* sobrescreve, ?\n?\s*nunca faz pull por cima/)
  })

  it('AGENTS.md: proteção cross-machine no publish é mencionada (preserva os dois trabalhos, nunca força)', () => {
    expect(agents).toMatch(/backend recusa/)
    expect(agents).toContain('nada se perde')
  })

  it('AGENTS.md: NUNCA git pull/fetch/merge manual — só o comando sync', () => {
    expect(agents).toMatch(/NUNCA\*{0,2} tente sincronizar você mesmo com/)
    expect(agents).toMatch(/git pull.{0,20}fetch.{0,20}merge/)
  })

  it('CLAUDE.md segue o mesmo contrato: sync no primeiro pedido, nunca manual, nunca sobrescreve', () => {
    expect(claude).toContain('npm run sync')
    expect(claude).toMatch(/checagem LEVE/)
    expect(claude).toMatch(/nunca\*{0,2} sobrescreve/i)
    expect(claude).toMatch(/Rodar `?sync`? fora do primeiro pedido da sessão/)
    expect(claude).toMatch(/git pull.{0,20}fetch.{0,20}merge.{0,10}à mão/)
  })
})

describe('workflow v3 — contrato assíncrono do agente (AGENTS.md/CLAUDE.md)', () => {
  const paths = files.map((f) => f.path)
  const agents = file('AGENTS.md')
  const claude = file('CLAUDE.md')
  const ciYml = file('.github/workflows/ci.yml')

  it('gera AGENTS.md (maiúsculo, canônico) e NÃO gera agents.md', () => {
    expect(paths).toContain('AGENTS.md')
    expect(paths).not.toContain('agents.md')
  })

  it('CLAUDE.md referencia AGENTS.md como regra canônica', () => {
    expect(claude).toContain('AGENTS.md')
    expect(claude).toMatch(/canônica/i)
  })

  it('NÃO instrui a esperar a CI depois de um push normal', () => {
    expect(agents).toMatch(/NUNCA espere a CI/i)
    expect(claude).toMatch(/Esperar ou pollar a CI/i)
  })

  it('NÃO instrui a fazer polling contínuo do GitHub', () => {
    expect(agents).toMatch(/não faça polling/i)
  })

  it('trata a CI como ASSÍNCRONA (segue desenvolvendo em background)', () => {
    expect(agents).toMatch(/assíncron/i)
    expect(agents).toMatch(/BACKGROUND/i)
    expect(agents).toMatch(/Continue desenvolvendo enquanto a CI roda/i)
  })

  it('preview persistente + HMR fazem parte do development loop', () => {
    expect(agents).toMatch(/HMR/)
    expect(agents).toMatch(/preview/i)
    expect(agents).toMatch(/preview:ensure/) // v3.1: supervisor persistente
    expect(agents).toMatch(/persistente/i)
  })

  it('npm run verify continua adaptativo e FULL não é ritual de toda microfeature', () => {
    expect(agents).toContain('npm run verify')
    expect(claude).toContain('npm run verify')
    expect(agents).toMatch(/QUICK/)
    expect(agents).toMatch(/SECURITY/)
    expect(agents).toMatch(/FULL/)
    expect(agents).toMatch(/verify:full[\s\S]{0,30}microaltera/i)
  })

  it('required checks continuam obrigatórios e só o HEAD atual é integrado', () => {
    expect(agents).toMatch(/required checks/i)
    expect(agents).toMatch(/HEAD atual/i)
  })

  it('SHA verde antigo NÃO libera SHA novo', () => {
    expect(agents).toMatch(/SHA\s+antigo nunca libera um SHA novo/i)
  })

  it('auto-merge é do GitHub e só após os gates verdes', () => {
    expect(agents).toMatch(/auto-merge/i)
    expect(agents).toMatch(/só então\s+auto-mergeia/i)
  })

  it('proíbe push direto na main, force push e bypass', () => {
    expect(agents).toMatch(/NUNCA.*push direto na .?main/i)
    expect(agents).toMatch(/force push na .?main/i)
    expect(agents).toMatch(/bypass de required checks/i)
  })

  it('proíbe enfraquecer teste/threshold/ruleset/gate para "ficar verde"', () => {
    expect(agents).toMatch(/nunca remova a barreira/i)
    expect(claude).toMatch(/ficar verde/i)
  })

  it('falha crítica de segurança é corrigida antes de trabalho dependente', () => {
    expect(agents).toMatch(/falha crítica de segurança[\s\S]*corrigida antes/i)
  })

  it('falha de CI de um checkpoint anterior: resumo barato + novo checkpoint, sem polling', () => {
    expect(agents).toMatch(/Falha de CI de um checkpoint anterior/i)
    expect(agents).toMatch(/resumo barato/i)
    expect(agents).toMatch(/novo checkpoint/i)
  })

  it('a corrida de auto-merge é do DAEMON, não do agente (rotate + delta, sem tocar o worktree)', () => {
    expect(agents).toMatch(/corrida de auto-merge/i)
    expect(agents).toMatch(/daemon.*rotaciona a branch|rotaciona a branch/i)
    expect(agents).toMatch(/delta/i)
    expect(agents).toMatch(/sem tocar o seu worktree|sem perder/i)
  })

  it('ci.yml cancela runs obsoletos por branch/PR sem liberar HEAD não validado', () => {
    expect(ciYml).toMatch(/concurrency:/)
    expect(ciYml).toMatch(/cancel-in-progress:\s*true/)
    expect(ciYml).toMatch(/github\.ref/)
  })

  it('pre-push bloqueia push direto na main (defesa local no Free)', () => {
    const hook = file('.githooks/pre-push')
    expect(hook).toMatch(/refs\/heads\/main/)
    expect(hook).toMatch(/bloqueado/i)
    expect(hook).toContain('scripts/verify.mjs') // segue validando também
  })

  it('operações destrutivas continuam exigindo humano (auto-merge não autoriza)', () => {
    expect(agents).toMatch(/destrutiv/i)
    expect(agents).toMatch(/confirmação explícita/i)
    expect(claude).toMatch(/auto-merge de código NÃO autoriza operação destrutiva/i)
  })

  it('preserva as regras-chave de segurança (Supabase local, migration, RLS, ref, secrets, server-side)', () => {
    expect(agents).toContain('npx supabase')
    expect(agents).toContain('migration')
    expect(agents).toMatch(/RLS/)
    expect(agents).toContain('project-ref')
    expect(agents).toMatch(/keychain/i)
    expect(agents).toMatch(/no servidor|do servidor/i)
  })

  it('AGENTS.md e CLAUDE.md ficam alinhados (mesmo contrato v3)', () => {
    for (const doc of [agents, claude]) {
      expect(doc).toMatch(/assíncron/i)
      expect(doc).toMatch(/HEAD atual|auto-merge/i)
      expect(doc).toMatch(/npm run verify/)
    }
  })
})

describe('primeira tela — o app abre antes de configurar nada', () => {
  it('o proxy renova a sessão sem estourar quando o Supabase não está configurado', () => {
    // Projeto recém-criado ainda não tem env do Supabase. O proxy padrão
    // renova a sessão, mas guarda a chamada: sem as variáveis ele apenas
    // segue com a CSP, em vez de estourar 500 em toda requisição.
    const proxy = file('proxy.ts')
    expect(proxy).toContain('if (supabaseUrl && supabaseKey)')
    expect(proxy).not.toContain('NEXT_PUBLIC_SUPABASE_URL!')
  })

  it('com login o proxy renova a sessão; app público não toca no Supabase', () => {
    const withAuth = buildProjectFiles({
      projectName: 'a',
      description: 'x',
      kind: 'solo',
    })
    const publicApp = buildProjectFiles({
      projectName: 'a',
      description: 'x',
      kind: 'public',
    })

    const proxyOf = (fs: typeof withAuth) =>
      fs.find((f) => f.path === 'proxy.ts')!.content

    // Com login, o proxy mantém o token vivo a cada requisição.
    expect(proxyOf(withAuth)).toContain('createServerClient')
    expect(proxyOf(withAuth)).toContain('supabase.auth.getUser()')

    // Público não carrega Supabase no proxy, nem cliente, nem tela de login:
    // nada de caminho autenticado morto num app que não tem usuários.
    expect(proxyOf(publicApp)).not.toContain('createServerClient')
    const publicPaths = publicApp.map((f) => f.path)
    expect(publicPaths).not.toContain('lib/supabase/server.ts')
    expect(publicPaths).not.toContain('app/login/page.tsx')

    // Os dois sempre carregam o nonce da CSP — é o que o proxy garante sempre.
    expect(proxyOf(withAuth)).toContain("'nonce-")
    expect(proxyOf(publicApp)).toContain("'nonce-")
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
    expect(() => file('AGENTS.md')).not.toThrow()
    expect(() => file('CLAUDE.md')).not.toThrow()
    expect(() => file('SECURITY.md')).not.toThrow()
  })
})

describe('gates obrigatórios', () => {
  const ci = file('.github/workflows/ci.yml')

  /**
   * A proteção de branch exige check POR NOME. Um nome que não existe no
   * workflow nunca fica verde, e o PR trava para sempre; um job do workflow
   * fora da lista roda, fica vermelho, e não impede o merge. Os dois erros
   * são silenciosos, então a coerência é testada nos dois sentidos.
   */
  it('todo nome exigido existe como job no workflow', () => {
    for (const name of CI_JOB_NAMES) {
      expect(ci, `job "${name}" não existe no ci.yml`).toContain(
        `name: ${name}`,
      )
    }
  })

  it('todo job do workflow (fora helpers) está na lista de obrigatórios', () => {
    // "Áreas afetadas" é um helper de gating: os gates dependem dele, então se
    // ele falhar os gates ficam pendentes e o merge trava do mesmo jeito. Não
    // é um gate em si, então não precisa estar na lista de obrigatórios.
    const HELPERS = ['Áreas afetadas']
    const declared = [...ci.matchAll(/^    name: (.+)$/gm)]
      .map((m) => m[1])
      .filter(
        (name): name is string =>
          typeof name === 'string' && !HELPERS.includes(name),
      )
    expect(declared.length).toBeGreaterThan(0)
    for (const name of declared) {
      expect(
        CI_JOB_NAMES as readonly string[],
        `job "${name}" roda mas não bloqueia o merge`,
      ).toContain(name)
    }
  })
})

describe('gates adaptativos — rápido sem perder segurança', () => {
  const ci = file('.github/workflows/ci.yml')

  it('o RLS só roda os passos pesados quando uma policy muda', () => {
    // O gate de RLS não pode reprovar se nenhuma migration mudou; subir um
    // Postgres nesse caso é só lentidão. Mas o job ainda reporta verde.
    expect(ci).toContain("db:\n              - 'supabase/**'")
    expect(ci).toContain("if: needs.changes.outputs.db == 'true'")
    expect(ci).toContain("if: needs.changes.outputs.db != 'true'")
  })

  it('o E2E só roda quando o app muda', () => {
    expect(ci).toContain("if: needs.changes.outputs.app == 'true'")
    expect(ci).toContain("if: needs.changes.outputs.app != 'true'")
  })

  it('os gates de segurança e correção NÃO são adaptativos — sempre rodam', () => {
    // Extrai o bloco de cada job e confirma que nada de segurança é pulado.
    const alwaysFull = [
      'Tipos, lint e auditoria',
      'Testes e cobertura',
      'Vulnerabilidades',
      'Varredura de segredos',
      'Build de produção',
    ]
    for (const name of alwaysFull) {
      const start = ci.indexOf(`name: ${name}`)
      const nextJob = ci.indexOf('\n  ', ci.indexOf('steps:', start))
      const block = ci.slice(start, nextJob > start ? nextJob : undefined)
      expect(block, `${name} não pode ter gating`).not.toContain(
        'needs.changes',
      )
    }
  })
})

describe('teste de RLS do scaffold', () => {
  const migration = file(
    'supabase/migrations/00000000000000_initial_schema.sql',
  )
  const rlsTest = file('supabase/rls.rls.test.ts')

  /**
   * A lista de tabelas testadas já foi escrita à mão e ficou para trás da
   * migration: `audit_logs` nascia com policy e sem nenhuma asserção provando
   * que a policy funciona, e o gate ficava verde por não olhar para ela.
   */
  it('cobre toda tabela da migration que tem coluna de dono', () => {
    const tables = [
      ...migration.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g),
    ].map((m) => m[1])

    expect(tables.length).toBeGreaterThan(1)

    for (const table of tables) {
      expect(rlsTest, `tabela ${table} sem teste de isolamento`).toContain(
        `RLS · ${table}`,
      )
    }
  })

  it('prova leitura, escrita e remoção por terceiro em cada tabela', () => {
    const suites = [...rlsTest.matchAll(/describe\('RLS · /g)].length
    const casos = [...rlsTest.matchAll(/\n  it\(/g)].length
    expect(casos).toBe(suites * 6)
  })
})

describe('login opcional — app com usuários vs. app público', () => {
  const withAuth = buildProjectFiles({
    projectName: 'meu-app',
    description: 'x',
    kind: 'solo',
  })
  const publicApp = buildProjectFiles({
    projectName: 'meu-app',
    description: 'x',
    kind: 'public',
  })
  const path = (fs: typeof withAuth, p: string) =>
    fs.find((f) => f.path === p)?.content ?? ''

  it('o padrão é ter login', () => {
    // Supremo é feito para app com dados de gente; público é a exceção.
    const defaultApp = buildProjectFiles({ projectName: 'a', description: 'x' })
    expect(defaultApp.some((f) => f.path === 'app/login/page.tsx')).toBe(true)
  })

  it('com login: a rota protegida decide o acesso no servidor', () => {
    const page = path(withAuth, 'app/app/page.tsx')
    // O gate real é getUser + redirect, não o proxy.
    expect(page).toContain('supabase.auth.getUser()')
    expect(page).toContain("redirect('/login')")
  })

  it('com login: sair e o retorno de OAuth existem', () => {
    expect(path(withAuth, 'app/auth/signout/route.ts')).toContain('signOut()')
    expect(path(withAuth, 'app/auth/callback/route.ts')).toContain(
      'exchangeCodeForSession',
    )
  })

  it('público: sem arquivo de auth e sem tabela que exige login', () => {
    const paths = publicApp.map((f) => f.path)
    expect(paths.filter((p) => p.startsWith('app/login'))).toHaveLength(0)
    expect(paths).not.toContain('app/auth/callback/route.ts')

    // A migration pública não cria tabela nem policy: sem login, RLS por
    // auth.uid() trancaria tudo fechado. (O comentário do arquivo explica
    // isso e cita auth.uid() — por isso a asserção olha CREATE, não o texto.)
    const migration = path(
      publicApp,
      'supabase/migrations/00000000000000_initial_schema.sql',
    )
    expect(migration).not.toContain('CREATE TABLE')
    expect(migration).not.toContain('CREATE POLICY')
  })

  it('público: o gate de RLS roda mesmo sem tabela de dono', () => {
    // Um arquivo de teste sem nenhum it() faria o vitest reclamar; o gerado
    // afirma explicitamente que não há isolamento a provar.
    const rls = path(publicApp, 'supabase/rls.rls.test.ts')
    expect(rls).toContain('nada a isolar')
    expect(rls).toMatch(/it\(/)
  })
})

describe('multi-tenant — o prédio nasce testado', () => {
  const team = buildProjectFiles({
    projectName: 'loja',
    description: 'x',
    kind: 'team',
  })
  const content = (p: string) => team.find((f) => f.path === p)?.content ?? ''
  const migration = content(
    'supabase/migrations/00000000000000_initial_schema.sql',
  )
  const rls = content('supabase/rls.rls.test.ts')

  it('a migration cria tenant, sócios e recurso de tenant', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS orgs')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS memberships')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS projects')
  })

  it('a policy de sócios existe — sem ela o app trava fechado', () => {
    // Descoberta contra Postgres real: sem SELECT em memberships, o EXISTS
    // das outras policies não enxerga nada.
    expect(migration).toContain('memberships_select_own')
    expect(migration).toContain('user_id = auth.uid()')
  })

  it('o teste gerado prova isolamento entre organizações', () => {
    expect(rls).toContain('RLS · projects (multi-tenant via memberships)')
    expect(rls).toContain('membro de OUTRO tenant NÃO lê a linha')
    expect(rls).toContain(
      'membro de outro tenant NÃO grava linha no tenant alheio',
    )
  })

  it('team tem login, como solo', () => {
    expect(team.some((f) => f.path === 'app/login/page.tsx')).toBe(true)
  })
})

describe('design system — apps nascem bonitos', () => {
  const layout = file('app/layout.tsx')
  const home = file('app/page.tsx')
  const css = file('app/globals.css')

  it('os primitivos vêm no scaffold', () => {
    const paths = files.map((f) => f.path)
    expect(paths).toContain('components/ui/button.tsx')
    expect(paths).toContain('components/ui/card.tsx')
    expect(paths).toContain('components/ui/input.tsx')
    expect(paths).toContain('components/ui/badge.tsx')
  })

  it('a tipografia Inter é self-hosted (sem bater na CSP)', () => {
    // next/font serve a fonte do próprio domínio — nada de fonts.googleapis
    // em runtime, que a CSP do app bloquearia.
    expect(layout).toContain("from 'next/font/google'")
    expect(layout).toContain('Inter(')
    expect(layout).toContain('inter.variable')
  })

  it('o tema tem superfícies em camadas e claro + escuro', () => {
    expect(css).toContain('--color-surface')
    expect(css).toContain('--color-elevated')
    expect(css).toContain('prefers-color-scheme: dark')
  })

  it('a home usa os primitivos, não HTML cru estilizado à mão', () => {
    expect(home).toContain("from '@/components/ui/card'")
    expect(home).toContain('<Card>')
  })
})

describe('scaffold v2 — local dev harness', () => {
  it('emite o harness (verify, setup:local, git hooks)', () => {
    expect(file('scripts/verify.mjs')).toContain('classify')
    expect(file('scripts/setup-local.mjs')).toContain('core.hooksPath')
    expect(file('.githooks/pre-commit')).toContain('verify.mjs')
    expect(file('.githooks/pre-push')).toContain('verify.mjs')
  })

  it('os git hooks são executáveis (mode 100755)', () => {
    const hook = files.find((f) => f.path === '.githooks/pre-commit')
    expect(hook?.mode).toBe('100755')
  })

  it('o package.json expõe verify em três níveis + setup:local', () => {
    for (const s of [
      'verify',
      'verify:quick',
      'verify:security',
      'verify:full',
      'setup:local',
    ]) {
      expect(Object.keys(packageJson.scripts)).toContain(s)
    }
  })

  it('não quebra os scripts base (test com exclude de rls continua)', () => {
    expect(packageJson.scripts.test).toContain('--exclude')
    expect(packageJson.scripts['dev:preview']).toBe('next dev --webpack')
  })
})

describe('scaffold v2 — identidade do projeto', () => {
  const identity = JSON.parse(file('.supremo/project.json')) as {
    scaffoldVersion: string
    securityBaselineVersion: string
    securityProfile: string
    capabilities: string[]
    projectId?: string
  }

  it('registra versão do scaffold, baseline e perfil', () => {
    expect(identity.scaffoldVersion).toBeTruthy()
    expect(identity.securityBaselineVersion).toBeTruthy()
    expect(identity.securityProfile).toBe('standard') // solo → auth → standard
  })

  it('solo deriva capability auth', () => {
    expect(identity.capabilities).toEqual(['auth'])
  })

  it('NUNCA carrega segredo (seção 25)', () => {
    const raw = file('.supremo/project.json').toLowerCase()
    for (const forbidden of [
      'token',
      'secret',
      'service_role',
      'password',
      'private_key',
      'anon',
    ]) {
      expect(raw).not.toContain(forbidden)
    }
  })

  it('team infere multitenant e deriva auth + multitenant', () => {
    const team = buildProjectFiles({
      projectName: 'time-x',
      description: 'SaaS',
      kind: 'team',
    })
    const id = JSON.parse(
      team.find((f) => f.path === '.supremo/project.json')!.content,
    ) as { securityProfile: string; capabilities: string[] }
    expect(id.securityProfile).toBe('multitenant')
    expect(id.capabilities).toEqual(['auth', 'multitenant'])
  })

  it('public é CORE puro (sem capabilities), perfil simple', () => {
    const pub = buildProjectFiles({
      projectName: 'site',
      description: 'landing',
      kind: 'public',
    })
    const id = JSON.parse(
      pub.find((f) => f.path === '.supremo/project.json')!.content,
    ) as { securityProfile: string; capabilities: string[] }
    expect(id.capabilities).toEqual([])
    expect(id.securityProfile).toBe('simple')
  })
})
