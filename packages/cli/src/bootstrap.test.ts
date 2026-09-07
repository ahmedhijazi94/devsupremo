import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { preCommitHook, prePushHook } from './git-hooks'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildEnvFile,
  cleanRemoteUrl,
  daemonCliOutputLooksValid,
  gitCloneArgs,
  checkNodeVersion,
  migrationDryRunSynced,
  patchConfigMajorVersion,
  previewStatusHealthy,
  previewStatusUrl,
  projectIdentityValid,
  gitHooksVerified,
  projectListHasRef,
  resolveSupabaseBin,
  supabaseLinkArgs,
  supabaseLinkEnv,
  targetDir,
  validateLocalReadiness,
} from './bootstrap'

describe('buildEnvFile', () => {
  it('serializa K=V por linha e termina com newline', () => {
    const out = buildEnvFile({
      NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon123',
    })
    expect(out).toBe(
      'NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=anon123\n',
    )
  })

  it('env vazio → só newline', () => {
    expect(buildEnvFile({})).toBe('\n')
  })
})

describe('targetDir', () => {
  it('padrão: pasta atual + nome do repo (cria automaticamente)', () => {
    expect(targetDir('ahmed/sistema-x')).toBe(
      path.join(process.cwd(), 'sistema-x'),
    )
  })

  it('respeita --dir', () => {
    expect(targetDir('ahmed/sistema-x', '/tmp/work')).toBe('/tmp/work/sistema-x')
  })
})

describe('clone seguro', () => {
  it('a URL do remote é limpa (sem token, sem @)', () => {
    const clean = cleanRemoteUrl('ahmed/sistema-x')
    expect(clean).toBe('https://github.com/ahmed/sistema-x.git')
    expect(clean).not.toContain('@')
  })

  it('os args do git clone NÃO contêm o token (só a env var referenciada)', () => {
    const args = gitCloneArgs('ahmed/sistema-x', 'main', '/tmp/dest')
    const joined = args.join(' ')
    // usa a URL limpa
    expect(joined).toContain('https://github.com/ahmed/sistema-x.git')
    // token nunca em argv — só a referência à env var
    expect(joined).toContain('SUPREMO_GIT_TOKEN')
    expect(joined).not.toContain('x-access-token:')
    // zera helpers do sistema antes do nosso
    expect(args).toContain('credential.helper=')
    expect(args).toContain('--branch')
  })
})

describe('supabase link seguro', () => {
  const SECRET = 'super-secret-db-pass'

  it('os args do link só carregam o ref — NUNCA a senha', () => {
    const args = supabaseLinkArgs('abcdefghijklmnop')
    expect(args).toEqual(['link', '--project-ref', 'abcdefghijklmnop'])
    expect(args.join(' ')).not.toContain(SECRET)
    expect(args.join(' ')).not.toMatch(/password|SUPABASE_DB_PASSWORD/i)
  })

  it('a senha vai só pela env do processo (SUPABASE_DB_PASSWORD)', () => {
    const env = supabaseLinkEnv({ PATH: '/usr/bin' }, SECRET)
    expect(env.SUPABASE_DB_PASSWORD).toBe(SECRET)
    expect(env.PATH).toBe('/usr/bin')
    // a senha nunca aparece nos args
    expect(supabaseLinkArgs('ref123').join(' ')).not.toContain(SECRET)
  })

  it('sem senha (projeto antigo/sem senha guardada) → não injeta a env', () => {
    const env = supabaseLinkEnv({ PATH: '/usr/bin' })
    expect(env.SUPABASE_DB_PASSWORD).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  it('não muta a env base recebida', () => {
    const base = { PATH: '/usr/bin' }
    supabaseLinkEnv(base, SECRET)
    expect('SUPABASE_DB_PASSWORD' in base).toBe(false)
  })
})

describe('detecção de divergência de conta (projectListHasRef)', () => {
  const output = `
   LINKED | ORG ID               | REFERENCE ID         | NAME
  --------|----------------------|----------------------|------
          | orgabc               | yhwevjxjdplsudrfatxn | app-a
          | orgabc               | kwmgtswgoquazjcffmun | app-b
`

  it('true quando o ref aparece na lista da conta logada', () => {
    expect(projectListHasRef(output, 'yhwevjxjdplsudrfatxn')).toBe(true)
  })

  it('false quando o projeto é de outra conta (ref ausente)', () => {
    expect(projectListHasRef(output, 'mkdzmimexvnhkcjjlhvr')).toBe(false)
  })
})

describe('config.toml — alinhar versão do Postgres', () => {
  const toml = `project_id = "app"

[db]
port = 54322
major_version = 15

[auth]
enabled = true
`

  it('troca o major_version para a versão do remoto', () => {
    const out = patchConfigMajorVersion(toml, 17)
    expect(out).toContain('major_version = 17')
    expect(out).not.toContain('major_version = 15')
  })

  it('mexe só na linha do major_version (resto intacto)', () => {
    const out = patchConfigMajorVersion(toml, 17)
    expect(out).toContain('project_id = "app"')
    expect(out).toContain('port = 54322')
    expect(out).toContain('[auth]')
  })

  it('sem a linha, devolve o conteúdo intacto', () => {
    const semDb = 'project_id = "x"\n'
    expect(patchConfigMajorVersion(semDb, 17)).toBe(semDb)
  })
})

describe('migration history — dry-run sincronizado', () => {
  it('true quando a CLI diz que está up to date', () => {
    expect(migrationDryRunSynced('Remote database is up to date.')).toBe(true)
  })

  it('true quando não lista nenhuma migration pendente', () => {
    expect(migrationDryRunSynced('Connecting to remote database...\n')).toBe(true)
  })

  it('false quando há migration pendente (nome com timestamp)', () => {
    expect(
      migrationDryRunSynced('Would push:\n  20260901230657_e2e_widgets.sql'),
    ).toBe(false)
  })
})

describe('--version reflete o package.json (sem hardcode)', () => {
  const binSrc = fs.readFileSync(
    fileURLToPath(new URL('./bin.ts', import.meta.url)),
    'utf8',
  )

  it('bin.ts deriva a versão de pkg.version (fonte única)', () => {
    expect(binSrc).toMatch(/\.version\(pkg\.version\)/)
  })

  it('nunca volta a hardcodar um literal de versão em .version()', () => {
    expect(binSrc).not.toMatch(/\.version\(\s*['"][\d.]+['"]\s*\)/)
  })
})

describe('CLI Supabase local pinada (resolveSupabaseBin)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bin-'))
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('sem node_modules → cai na global (último recurso)', () => {
    expect(resolveSupabaseBin(tmp)).toEqual({ bin: 'supabase', local: false })
  })

  it('com a CLI instalada → usa a LOCAL pinada, não a global', () => {
    const bin = path.join(tmp, 'node_modules', '.bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'supabase'), '#!/bin/sh\n')
    const r = resolveSupabaseBin(tmp)
    expect(r.local).toBe(true)
    expect(r.bin).toBe(path.join(tmp, 'node_modules', '.bin', 'supabase'))
  })
})

describe('daemonCliOutputLooksValid — detecta CLI publicada desatualizada', () => {
  it('saída real (JSON machine-readable, {"running":bool,...}) é válida', () => {
    expect(
      daemonCliOutputLooksValid('{"running":true,"healthy":true,"pid":123,"pendingCheckpoints":0}'),
    ).toBe(true)
    expect(
      daemonCliOutputLooksValid('{"running":false,"healthy":false,"pid":null,"pendingCheckpoints":0}'),
    ).toBe(true)
  })
  it('falha ao rodar (null) é inválida', () => {
    expect(daemonCliOutputLooksValid(null)).toBe(false)
  })
  it('JSON sem o campo "running" (formato inesperado) é inválido', () => {
    expect(daemonCliOutputLooksValid('{"foo":"bar"}')).toBe(false)
  })
  it('saída da ponte MCP (CLI publicada sem "daemon", texto — não JSON) é inválida', () => {
    expect(
      daemonCliOutputLooksValid('[supremo] SUPREMO_URL não definido...\n'),
    ).toBe(false)
  })
  it('erro de opção desconhecida é inválido', () => {
    expect(daemonCliOutputLooksValid("error: unknown option '--status'\n")).toBe(false)
  })
})

describe('validateLocalReadiness — bootstrap só declara "pronto" se for verdade', () => {
  it('tudo certo (daemon E preview saudáveis) → ok, sem issues', () => {
    const r = validateLocalReadiness({
      setupSucceeded: true, gitHooksVerified: true, lifecycleVerified: true,
      validationWorkerAvailable: true, databaseEnvironmentReady: true, integrationMode: 'enforced',
      projectJsonOk: true,
      hasDaemonIdentity: true,
      daemonRunning: true,
      npmScriptsCompatible: true,
      previewHealthy: true,
    })
    expect(r).toEqual({ ok: true, state: 'ready', integrationMode: 'enforced', issues: [] })
  })

  it('project.json ausente/incompleto → issue mesmo sem daemon', () => {
    const r = validateLocalReadiness({
      setupSucceeded: true, gitHooksVerified: true, lifecycleVerified: true,
      validationWorkerAvailable: true, databaseEnvironmentReady: true, integrationMode: 'enforced',
      projectJsonOk: false,
      hasDaemonIdentity: false,
      daemonRunning: false,
      npmScriptsCompatible: null,
      previewHealthy: true,
    })
    expect(r.ok).toBe(false)
    expect(r.issues[0]).toMatch(/project\.json/)
  })

  it('daemon não subiu → issue (só quando há identidade de device)', () => {
    const r = validateLocalReadiness({
      setupSucceeded: true, gitHooksVerified: true, lifecycleVerified: true,
      validationWorkerAvailable: true, databaseEnvironmentReady: true, integrationMode: 'enforced',
      projectJsonOk: true,
      hasDaemonIdentity: true,
      daemonRunning: false,
      npmScriptsCompatible: true,
      previewHealthy: true,
    })
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.includes('daemon não subiu'))).toBe(true)
  })

  it('CLI publicada incompatível → issue explícita (a causa raiz do bug real)', () => {
    const r = validateLocalReadiness({
      setupSucceeded: true, gitHooksVerified: true, lifecycleVerified: true,
      validationWorkerAvailable: true, databaseEnvironmentReady: true, integrationMode: 'enforced',
      projectJsonOk: true,
      hasDaemonIdentity: true,
      daemonRunning: true,
      npmScriptsCompatible: false,
      previewHealthy: true,
    })
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.includes('desatualizada'))).toBe(true)
  })

  it('sem identidade de daemon → nunca declara experiência automática pronta', () => {
    const r = validateLocalReadiness({
      setupSucceeded: true, gitHooksVerified: true, lifecycleVerified: true,
      validationWorkerAvailable: true, databaseEnvironmentReady: true, integrationMode: 'enforced',
      projectJsonOk: true,
      hasDaemonIdentity: false,
      daemonRunning: false,
      npmScriptsCompatible: null,
      previewHealthy: true,
    })
    expect(r.state).toBe('not_ready')
    expect(r.issues).toContain('identidade do checkpoint daemon ausente')
  })

  it('preview não saudável → issue, MESMO com daemon perfeito (bug real: bootstrap declarava pronto com preview morto)', () => {
    const r = validateLocalReadiness({
      setupSucceeded: true, gitHooksVerified: true, lifecycleVerified: true,
      validationWorkerAvailable: true, databaseEnvironmentReady: true, integrationMode: 'enforced',
      projectJsonOk: true,
      hasDaemonIdentity: true,
      daemonRunning: true,
      npmScriptsCompatible: true,
      previewHealthy: false,
    })
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.includes('preview'))).toBe(true)
  })
})

describe('previewStatusHealthy — mesma forma de daemonCliOutputLooksValid, para o preview', () => {
  it('running+healthy → true', () => {
    expect(previewStatusHealthy('{"running":true,"healthy":true,"pid":1,"port":3000,"url":"http://localhost:3000"}')).toBe(true)
  })
  it('running mas não healthy → false', () => {
    expect(previewStatusHealthy('{"running":true,"healthy":false,"pid":1}')).toBe(false)
  })
  it('não rodando → false', () => {
    expect(previewStatusHealthy('{"running":false,"healthy":false,"pid":null}')).toBe(false)
  })
  it('null (falhou ao rodar) → false', () => {
    expect(previewStatusHealthy(null)).toBe(false)
  })
  it('JSON inválido → false (fail-closed)', () => {
    expect(previewStatusHealthy('not json')).toBe(false)
  })
})

describe('checkNodeVersion — aviso claro, NUNCA bloqueia (seção 8)', () => {
  it.each([20, 22, 24])('Node %i LTS → ok, sem mensagem', (major) => {
    const r = checkNodeVersion(`v${major}.10.0`)
    expect(r).toEqual({ status: 'ok', major })
  })

  it('Node 23 (release Current, o caso real do E2E) → warn com recomendação de Node 22 LTS', () => {
    const r = checkNodeVersion('v23.11.0')
    expect(r.status).toBe('warn')
    expect(r.major).toBe(23)
    if (r.status === 'warn') {
      expect(r.message).toMatch(/Node 22 LTS/)
      expect(r.message).toContain('v23.11.0')
    }
  })

  it('Node 21 (outra release Current) → warn', () => {
    expect(checkNodeVersion('v21.0.0').status).toBe('warn')
  })

  it('Node 18 (fora do engines atual do template, >=20) → warn', () => {
    expect(checkNodeVersion('v18.19.0').status).toBe('warn')
  })
})


describe('bootstrap verifies real installed gates and public identity', () => {
  it.skipIf(process.platform === 'win32')('rejects a POSIX FIFO without blocking bootstrap', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-bootstrap-fifo-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root })
      fs.mkdirSync(path.join(root, '.githooks'))
      execFileSync('mkfifo', [path.join(root, '.githooks/pre-commit')])
      fs.writeFileSync(path.join(root, '.githooks/pre-push'), prePushHook, { mode: 0o755 })
      // A separate process and a hard timeout make the pre-fix hanging open
      // fail the regression without freezing the whole test runner.
      const source = fileURLToPath(new URL('./bootstrap.ts', import.meta.url))
      const output = execFileSync(process.execPath, ['--import', 'tsx', '-e',
        'const {gitHooksVerified} = require(process.argv[1]); process.stdout.write(String(gitHooksVerified(process.argv[2])));',
        source, root], { cwd: process.cwd(), encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' })
      expect(output).toBe('false')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }, 10_000)

  it.each(['symlink', 'not-executable', 'directory'] as const)('rejects %s instead of declaring Git hooks ready', (scenario) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-bootstrap-gate-kind-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root })
      fs.mkdirSync(path.join(root, '.githooks'))
      const hook = path.join(root, '.githooks/pre-commit')
      fs.writeFileSync(hook, preCommitHook, { mode: 0o755 })
      fs.writeFileSync(path.join(root, '.githooks/pre-push'), prePushHook, { mode: 0o755 })
      if (scenario === 'not-executable') {
        fs.chmodSync(hook, 0o644)
      } else {
        fs.unlinkSync(hook)
        if (scenario === 'directory') fs.mkdirSync(hook)
        else {
          const target = path.join(root, 'outside-hook')
          fs.writeFileSync(target, preCommitHook, { mode: 0o755 })
          fs.symlinkSync(target, hook)
        }
      }
      expect(gitHooksVerified(root)).toBe(false)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('does not accept a hook that mentions verify but exits before validation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-bootstrap-gates-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root })
      fs.mkdirSync(path.join(root, '.githooks'))
      fs.writeFileSync(path.join(root, '.githooks/pre-commit'), preCommitHook, { mode: 0o755 })
      fs.writeFileSync(path.join(root, '.githooks/pre-push'), prePushHook, { mode: 0o755 })
      expect(gitHooksVerified(root)).toBe(true)
      fs.writeFileSync(path.join(root, '.githooks/pre-commit'), '#!/bin/sh\nexit 0\n# scripts/verify.mjs\n')
      expect(gitHooksVerified(root)).toBe(false)
    } finally { fs.rmSync(root, { force: true, recursive: true }) }
  })
  it('uses the actual healthy preview URL and never invents port 3000', () => {
    expect(previewStatusUrl(JSON.stringify({ running: true, healthy: true, url: 'http://localhost:3017' }))).toBe('http://localhost:3017')
    expect(previewStatusUrl(JSON.stringify({ running: true, healthy: true }))).toBeNull()
    expect(previewStatusUrl(JSON.stringify({ running: true, healthy: false, url: 'http://localhost:3017' }))).toBeNull()
    expect(previewStatusUrl(JSON.stringify({ running: true, healthy: true, url: 'https://production.example.com' }))).toBeNull()
  })
  it('only accepts HTTPS control plane or HTTP loopback for the expected project', () => {
    const data = (projectId: string, supremoUrl: string) => JSON.stringify({ projectId, supremoUrl })
    expect(projectIdentityValid(data('one', 'https://supremo.example.com'), 'one')).toBe(true)
    expect(projectIdentityValid(data('one', 'http://localhost:9000'), 'one')).toBe(true)
    expect(projectIdentityValid(data('one', 'http://remote.example.com'), 'one')).toBe(false)
    expect(projectIdentityValid(data('two', 'https://supremo.example.com'), 'one')).toBe(false)
  })
})
