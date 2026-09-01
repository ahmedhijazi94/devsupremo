import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildEnvFile,
  cleanRemoteUrl,
  gitCloneArgs,
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
