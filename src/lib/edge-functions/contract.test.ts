import { describe, expect, it } from 'vitest'
import { FUNCTION_FILE_BYTES, functionDeploySchema, functionOptionsSchema, functionPathSchema, functionRequestSchema, functionResponseSchema } from './contract'

const entrypoint = 'supabase/functions/send-email/index.js'
const bundle = { slug: 'send-email', environment: 'development', entrypoint, files: [{ path: entrypoint, content: 'Deno.serve(() => new Response())' }] }
describe('bounded explicit Edge Function source contract', () => {
  it('accepts explicit project-relative shared dependencies and import maps', () => {
    expect(functionDeploySchema.parse({ ...bundle, importMap: 'supabase/functions/send-email/deno.json', files: [
      ...bundle.files, { path: 'src/features/auth/email-hook-core.ts', content: 'export const hook = true' },
      { path: 'supabase/functions/send-email/deno.json', content: '{"imports":{"zod":"npm:zod@4.5.4"}}' },
    ] }).verifyJwt).toBe(true)
  })
  it.each(['../index.ts', '/src/index.ts', 'src/../secrets.ts', 'src/.env.json', 'src/env.json', 'src/credentials.json', 'src/private-key.json',
    'src/node_modules/module.ts', 'supabase/functions/../a.ts', 'src/a\\b.ts', 'src/a%2fb.ts', 'src//a.ts', 'src/a.ts\n', 'src/a.pem', 'package.json', 'supabase/config.toml'])('rejects unsafe source path %s', path => {
    expect(functionPathSchema.safeParse(path).success).toBe(false)
  })
  it('rejects missing entrypoint/import map, mismatched slug, duplicate portable paths and binary/invalid UTF-8', () => {
    for (const patch of [
      { entrypoint: 'src/index.js' }, { slug: 'another' }, { importMap: 'src/missing.json' },
      { files: [...bundle.files, ...bundle.files] }, { files: [...bundle.files, { path: entrypoint.replace('index', 'INDEX'), content: '' }] },
      { files: [{ path: entrypoint, content: 'a\0b' }] }, { files: [{ path: entrypoint, content: '\ud800' }] },
    ]) expect(functionDeploySchema.safeParse({ ...bundle, ...patch }).success).toBe(false)
  })
  it('enforces real UTF-8 byte limits per file, total and count', () => {
    expect(functionDeploySchema.safeParse({ ...bundle, files: [{ path: entrypoint, content: '😀'.repeat(FUNCTION_FILE_BYTES / 2) }] }).success).toBe(false)
    expect(functionDeploySchema.safeParse({ ...bundle, files: Array.from({ length: 5 }, (_, i) => ({ path: i ? `src/${i}.ts` : entrypoint, content: 'x'.repeat(FUNCTION_FILE_BYTES) })) }).success).toBe(false)
    expect(functionDeploySchema.safeParse({ ...bundle, files: Array.from({ length: 65 }, (_, i) => ({ path: i ? `src/${i}.ts` : entrypoint, content: '' })) }).success).toBe(false)
  })
  it('validates bundle invariants again in options and HTTP request envelopes', () => {
    const fields = { ...bundle, slug: 'other', operation: 'functions-deploy' }
    expect(functionOptionsSchema.safeParse(fields).success).toBe(false)
    expect(functionRequestSchema.safeParse({ ...fields, projectId: '00000000-0000-4000-8000-000000000001', deviceSecret: 'device-fixture', expectedRef: 'dev-ref' }).success).toBe(false)
  })
  it.each(['unknown', undefined])('rejects unspecified or unsupported environment %s', environment => {
    expect(functionOptionsSchema.safeParse({ operation: 'functions-list', environment }).success).toBe(false)
  })
  it('accepts explicit production without defaulting or inferring it', () => {
    expect(functionOptionsSchema.parse({ operation: 'functions-list', environment: 'production' })).toEqual({ operation: 'functions-list', environment: 'production' })
  })
  it('accepts only the fixed private hook name and no value, URI, or raw provider configuration', () => {
    const request = { operation: 'functions-hook-configure', environment: 'development', slug: 'send-email' }
    expect(functionOptionsSchema.parse(request)).toMatchObject({ secretName: 'AUTH_SEND_EMAIL_HOOK_SECRET' })
    for (const patch of [{ secretName: 'SUPABASE_AUTH_HOOK_SECRET' }, { value: 'secret' }, { uri: 'https://evil.test' }, { config: {} }])
      expect(functionOptionsSchema.safeParse({ ...request, ...patch }).success).toBe(false)
  })
  it('strips all unlisted response fields at every metadata layer', () => {
    const result = functionResponseSchema.parse({ operation: 'functions-list', projectId: '00000000-0000-4000-8000-000000000001',
      projectRef: 'dev-ref', environment: 'development', observedAt: '2026-09-24T00:00:00.000Z', execution: 'server_api', providerDashboardRequired: false,
      valuesReceived: false, readOnly: true, secret: 'never-return', data: { token: 'never-return', functions: [{ slug: 'send-email', status: 'ACTIVE', version: 1,
        verifyJwt: false, token: 'never-return', source: 'never-return' }] } })
    expect(JSON.stringify(result)).not.toContain('never-return')
  })
})
