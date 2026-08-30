import { describe, it, expect } from 'vitest'
import {
  previewProjectName,
  isDeployable,
  sharedPreviewConfig,
} from './preview'

describe('previewProjectName', () => {
  const id = '6a738536-572f-4c6c-a420-47fc76144574'

  it('usa prefixo, nome e parte do id', () => {
    expect(previewProjectName('meu-app', id)).toBe('sp-meu-app-6a738536')
  })

  it('normaliza acentos e espaços', () => {
    expect(previewProjectName('Configuração Rápida', id)).toBe(
      'sp-configuracao-rapida-6a738536',
    )
  })

  it('só usa caracteres que a Vercel aceita', () => {
    expect(previewProjectName('App! #2 (v3)', id)).toMatch(/^[a-z0-9-]+$/)
  })

  it('não termina com hífen', () => {
    expect(previewProjectName('nome---', id)).not.toMatch(/-$/)
  })

  it('cabe no limite da Vercel', () => {
    const longo = 'a'.repeat(200)
    expect(previewProjectName(longo, id).length).toBeLessThanOrEqual(100)
  })

  it('nome vazio ainda gera projeto válido', () => {
    expect(previewProjectName('!!!', id)).toBe('sp-projeto-6a738536')
  })

  it('projetos diferentes não colidem', () => {
    const outro = '11111111-2222-3333-4444-555555555555'
    expect(previewProjectName('mesmo-nome', id)).not.toBe(
      previewProjectName('mesmo-nome', outro),
    )
  })
})

describe('isDeployable', () => {
  it.each([
    'app/page.tsx',
    'package.json',
    'next.config.ts',
    'lib/utils.ts',
    'supabase/migrations/001.sql',
  ])('inclui %s', (path) => {
    expect(isDeployable(path)).toBe(true)
  })

  it.each([
    'node_modules/react/index.js',
    '.next/build-manifest.json',
    '.git/config',
    'coverage/lcov.info',
    'e2e/smoke.spec.ts',
    'public/logo.png',
    'assets/video.mp4',
  ])('exclui %s', (path) => {
    expect(isDeployable(path)).toBe(false)
  })

  it('não confunde caminho que só contém a palavra', () => {
    expect(isDeployable('app/components/next-steps.tsx')).toBe(true)
    expect(isDeployable('docs/node_modules-guia.md')).toBe(true)
  })
})

describe('sharedPreviewConfig', () => {
  it('sem token, o preview compartilhado fica desligado', () => {
    const original = process.env.SUPREMO_PREVIEW_VERCEL_TOKEN
    delete process.env.SUPREMO_PREVIEW_VERCEL_TOKEN
    expect(sharedPreviewConfig()).toBeNull()
    if (original) process.env.SUPREMO_PREVIEW_VERCEL_TOKEN = original
  })

  it('com token, devolve a configuração', () => {
    process.env.SUPREMO_PREVIEW_VERCEL_TOKEN = 'tok'
    process.env.SUPREMO_PREVIEW_VERCEL_TEAM_ID = 'team_1'
    expect(sharedPreviewConfig()).toEqual({ token: 'tok', teamId: 'team_1' })
    delete process.env.SUPREMO_PREVIEW_VERCEL_TOKEN
    delete process.env.SUPREMO_PREVIEW_VERCEL_TEAM_ID
  })

  it('teamId é opcional — conta pessoal não tem', () => {
    process.env.SUPREMO_PREVIEW_VERCEL_TOKEN = 'tok'
    delete process.env.SUPREMO_PREVIEW_VERCEL_TEAM_ID
    expect(sharedPreviewConfig()?.teamId).toBeNull()
    delete process.env.SUPREMO_PREVIEW_VERCEL_TOKEN
  })
})
