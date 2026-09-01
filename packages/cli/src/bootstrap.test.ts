import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildEnvFile,
  cleanRemoteUrl,
  gitCloneArgs,
  projectListHasRef,
  supabaseLinkArgs,
  supabaseLinkEnv,
  targetDir,
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
