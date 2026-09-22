import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function audit(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'supremo-ast-audit-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'scripts'))
  copyFileSync(resolve('scripts/security-audit.js'), join(dir, 'scripts/security-audit.js'))
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), 'dir')
  for (const [name, content] of Object.entries({ '.gitignore': '.env*\n', ...files })) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  const result = spawnSync(process.execPath, ['scripts/security-audit.js', '--strict', '--json'], { cwd: dir, encoding: 'utf8' })
  expect(result.error).toBeUndefined()
  expect(result.stderr).toBe('')
  const report = JSON.parse(result.stdout) as { findings: Array<{ category: string; severity: string; file: string; code: string }> }
  return { status: result.status, findings: report.findings, category: (name: string) => report.findings.filter(f => f.category === name) }
}
const authenticated = "const { data: { user } } = await client.auth.getUser(); if (!user) throw Error('unauthorized');"
const validate = 'const parsed = schema.parse(input);'

describe('auditor AST do TanStack Start', () => {
  const imports = `import { createServerFn } from '@tanstack/react-start'; import { z } from 'zod';`
  const start = `import { createStart, createCsrfMiddleware } from '@tanstack/react-start';
    const csrf = createCsrfMiddleware({ filter: ctx => ctx.handlerType === 'serverFn' });
    export const startInstance = createStart(() => ({ requestMiddleware: [csrf] }));`

  it('inspeciona RPC sem diretiva Next e rejeita I/O sem identidade', () => {
    const result = audit({ 'src/features/items.functions.ts': `${imports}
      export const list = createServerFn().handler(async () => client.from('items').select('*'));` })
    expect(result.category('AUTHZ')).toHaveLength(1)
    expect(result.status).toBe(1)
  })

  it('alias da importação createServerFn continua sendo endpoint inspecionado', () => {
    const result = audit({ 'src/features/items.functions.ts': `import { createServerFn as rpc } from '@tanstack/react-start';
      export const list = rpc().handler(async () => client.from('items').select('*'));` })
    expect(result.category('AUTHZ')).toHaveLength(1)
  })

  it('namespace import continua sendo endpoint inspecionado', () => {
    const result = audit({ 'src/features/items.functions.ts': `import * as start from '@tanstack/react-start';
      export const list = start.createServerFn().handler(async () => client.from('items').select('*'));` })
    expect(result.category('AUTHZ')).toHaveLength(1)
  })

  it('referência indireta de handler falha fechada em RPC e rota', () => {
    const result = audit({
      'src/features/items.functions.ts': `${imports} export const list = createServerFn().handler(loadPrivate);`,
      'src/routes/api.ts': `import { createFileRoute } from '@tanstack/react-router';
        export const Route = createFileRoute('/api')({ server: { handlers: { GET: loadPrivate } } });`,
    })
    expect(result.category('SERVER_ENDPOINT_SHAPE')).toHaveLength(2)
    expect(result.status).toBe(1)
  })

  it('valida parâmetros desestruturados, inclusive em leituras privadas', () => {
    const result = audit({ 'src/features/items.functions.ts': `${imports}
      export const list = createServerFn().handler(async ({ data }) => { await requireUser();
        return client.from('items').select('*').eq('id', data.id).eq('user_id', user.id); });` })
    expect(result.category('SERVER_INPUT')).toHaveLength(1)
  })

  it.each(['inputValidator', 'validator'])('reconhece schema runtime em %s e isolamento explícito', (validator) => {
    const result = audit({ 'src/features/items.functions.ts': `${imports}
      const schema = z.object({ id: z.string().uuid() });
      export const remove = createServerFn({ method: 'POST' }).${validator}(schema).handler(async ({ data }) => {
        const user = await requireUser(); return client.from('items').delete().eq('id', data.id).eq('user_id', user.id); });` })
    expect(result.findings).toEqual([])
    expect(result.status).toBe(0)
  })

  it('validator identidade não é prova de validação e payload não é identidade', () => {
    const result = audit({ 'src/features/items.functions.ts': `${imports}
      export const remove = createServerFn({ method: 'POST' }).inputValidator(data => data).handler(async ({ data }) => {
        await requireUser(); return client.from('items').delete().eq('user_id', data.userId); });` })
    expect(result.category('SERVER_INPUT')).toHaveLength(1)
    expect(result.category('AUTHZ_SCOPE')).toHaveLength(1)
  })

  it('segue implementação server-only importada sem tratar wrapper inteiro como exceção', () => {
    const result = audit({
      'src/features/items.functions.ts': `${imports} import { remove } from './items.server';
        export const save = createServerFn({ method: 'POST' }).inputValidator(z.string()).handler(async ({ data }) => remove(data));`,
      'src/features/items.server.ts': `import '@tanstack/react-start/server-only';
        export async function remove(id) { return client.from('items').delete().eq('id', id); }`,
    })
    expect(result.category('AUTHZ')).toHaveLength(1)
    expect(result.category('IDOR').some((item) => item.severity === 'HIGH')).toBe(true)
  })

  it('guard dentro de helper não chamado não autoriza server function', () => {
    const result = audit({ 'src/features/items.functions.ts': `${imports}
      export const list = createServerFn().handler(async () => {
        async function unused() { await requireUser(); } return client.from('items').select('*'); });` })
    expect(result.category('AUTHZ')).toHaveLength(1)
  })

  it('reconhece server routes e exige identidade/origin antes da mutação', () => {
    const result = audit({ 'src/routes/api.items.ts': `import { createFileRoute } from '@tanstack/react-router';
      export const Route = createFileRoute('/api/items')({ server: { handlers: {
        POST: async ({ request }) => { return client.from('items').delete().eq('id', request.id); }
      } } });` })
    expect(result.category('AUTHZ')).toHaveLength(1)
    expect(result.category('SERVER_ORIGIN')).toHaveLength(1)
    expect(result.status).toBe(1)
  })

  it('beforeLoad com auth não autoriza o endpoint de uma rota', () => {
    const result = audit({ 'src/routes/api.items.ts': `import { createFileRoute } from '@tanstack/react-router';
      export const Route = createFileRoute('/api/items')({ beforeLoad: async () => requireUser(),
        server: { handlers: { GET: async () => client.from('items').select('*') } } });` })
    expect(result.category('AUTHZ')).toHaveLength(1)
  })

  it('aceita negação same-origin antes de logout e rejeita guard posterior', () => {
    const prefix = `import { createFileRoute } from '@tanstack/react-router';
      export const Route = createFileRoute('/auth/signout')({server:{handlers:{POST:async({request})=>{`
    const guard = `if (!isSameOrigin(request)) return new Response('denied', {status:403});`
    const safe = audit({ 'src/routes/auth.signout.ts': prefix + guard + `await client.auth.signOut(); return new Response('ok'); }}}});` })
    expect(safe.category('SERVER_ORIGIN')).toHaveLength(0)
    const late = audit({ 'src/routes/auth.signout.ts': prefix + `await client.auth.signOut();` + guard + `return new Response('ok'); }}}});` })
    expect(late.category('SERVER_ORIGIN')).toHaveLength(1)
  })

  it('protege componentes Start sem use client contra imports server-only', () => {
    const result = audit({
      'src/routes/index.tsx': `import { createServerFn } from '@tanstack/react-start'; import { secret } from '../lib/private.server';
        export function Page() { return <p>{secret}</p> }`,
      'src/lib/private.server.ts': `import '@tanstack/react-start/server-only'; export const secret = process.env.PAYMENT_KEY;`,
    })
    expect(result.category('CLIENT_SERVER_BOUNDARY')).toHaveLength(1)
  })

  it('prefixo VITE não torna chave administrativa pública permitida', () => {
    const result = audit({ 'src/routes/index.tsx': `${imports}
      export function Page() { return <p>{import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY}</p> }` })
    expect(result.category('CLIENT_SERVER_BOUNDARY')).toHaveLength(1)
    const safe = audit({ 'src/routes/index.tsx': `${imports}
      export function Page() { return <p>{import.meta.env.VITE_SUPABASE_URL}</p> }` })
    expect(safe.category('CLIENT_SERVER_BOUNDARY')).toHaveLength(0)
  })

  it('arquivo de rota universal .ts também protege acesso a segredo em loader', () => {
    const result = audit({ 'src/routes/secret.ts': `${imports}
      export const loader = () => process.env.INTERNAL_TOKEN;` })
    expect(result.category('CLIENT_SERVER_BOUNDARY')).toHaveLength(1)
  })

  it('permite helper server-only exclusivamente dentro do handler RPC', () => {
    const result = audit({
      'src/routes/index.tsx': `import { getLabel } from '../features/label.functions'; export function Page() { return <p>Ok</p> }`,
      'src/features/label.functions.ts': `${imports} import { getLabelValue } from './label.server';
        export const getLabel = createServerFn().handler(async () => getLabelValue());`,
      'src/features/label.server.ts': `import '@tanstack/react-start/server-only'; export function getLabelValue() { return 'Safe public label'; }`,
    })
    expect(result.findings).toEqual([])
  })

  it('wrapper RPC não esconde exportação universal adicional que vaza segredo', () => {
    const result = audit({
      'src/routes/index.tsx': `import { leak } from '../features/label.functions'; export function Page() { return <p>{leak()}</p> }`,
      'src/features/label.functions.ts': `${imports} import { secret } from './label.server';
        export const label = createServerFn().handler(async () => 'safe'); export const leak = () => secret;`,
      'src/features/label.server.ts': `import '@tanstack/react-start/server-only'; export const secret = process.env.PAYMENT_KEY;`,
    })
    expect(result.category('CLIENT_SERVER_BOUNDARY')).toHaveLength(1)
  })

  it('createStart exige CSRF instalado, não apenas importado/construído', () => {
    expect(audit({ 'src/start.ts': start }).findings).toEqual([])
    const result = audit({ 'src/start.ts': start.replace('[csrf]', '[]') })
    expect(result.category('SERVER_ORIGIN')).toHaveLength(1)
    expect(result.status).toBe(1)
  })

  it('bloqueia opt-outs de CSRF e import protection em configuração Start', () => {
    const result = audit({
      'src/start.ts': start.replace("filter: ctx => ctx.handlerType === 'serverFn'", 'allowRequestsWithoutOriginCheck: true'),
      'vite.config.mts': `export default { importProtection: false, serverFns: { disableCsrfMiddlewareWarning: true } };`,
    })
    expect(result.category('START_SECURITY_CONFIG')).toHaveLength(3)
    expect(result.category('SERVER_ORIGIN')).toHaveLength(1)
  })
})

describe('auditor AST executável', () => {
  it('detecta IDOR real com literais preservados e ignora exemplo em comentário/string', () => {
    const result = audit({ 'app/actions.ts': `'use server';
      const example = "client.from('other').delete().eq('id', input)";
      // client.from('comment').delete().eq('id', input)
      export async function remove(input: string) { ${validate} ${authenticated}
        return client.from('tickets').delete().eq('id', parsed); }` })
    expect(result.status).toBe(1)
    expect(result.category('IDOR')).toHaveLength(1)
    expect(result.category('IDOR')[0]?.code).toContain("from('tickets')")
  })
  it('aceita o filtro de dono com sessão e entrada validadas na mesma operação', () => {
    const result = audit({ 'app/actions.ts': `'use server';
      export const remove = async (input: string) => { ${validate} ${authenticated}
        return client.from('tickets').delete().eq('id', parsed).eq('user_id', user.id); };` })
    expect(result.findings).toEqual([])
    expect(result.status).toBe(0)
  })
  it.each([
    "export async function guarded() { await requireUser(); } export const remove = async () => client.from('tickets').delete();",
    "export async function remove() { async function unused() { await requireUser(); } return client.from('tickets').delete(); }",
    "export async function remove() { await client.from('tickets').delete(); await requireUser(); }",
  ])('uma chamada de auth alheia/atrasada não autoriza a entrada: %s', (body) => {
    const result = audit({ 'app/actions.ts': `'use server'; ${body}` })
    expect(result.status).toBe(1)
    expect(result.category('AUTHZ')).toHaveLength(1)
  })
  it('reconhece Server Action inline e exige validar parâmetros antes de persistir', () => {
    const result = audit({ 'app/page.tsx': `export default function Page() {
      async function save(input: string) { 'use server'; ${authenticated}
        await client.from('tickets').update({ title: input }).eq('user_id', user.id); }
      return null;
    }` })
    expect(result.category('SERVER_INPUT')).toHaveLength(1)
    expect(result.status).toBe(1)
  })
  it('segue importação dinâmica desde components/ da raiz até segredo servidor', () => {
    const result = audit({
      'components/feature.tsx': `'use client'; export async function load() { return import('../lib/private') }`,
      'lib/private.ts': 'export const token = process.env.PAYMENT_PRIVATE_KEY;',
    })
    expect(result.category('CLIENT_SERVER_BOUNDARY')).toHaveLength(1)
    expect(result.status).toBe(1)
  })
  it('permite RPC de Server Action, mas bloqueia mutação direta no client', () => {
    const result = audit({ 'components/feature.tsx': `'use client';
      export async function save() { return client.from('tickets').insert({ title: 'new' }); }` })
    expect(result.category('CLIENT_MUTATION')).toHaveLength(1)
  })
  it('mutação em helper importado também pertence à fronteira cliente', () => {
    const result = audit({
      'components/feature.tsx': "'use client'; import { save } from '../lib/mutation'; export const submit = save;",
      'lib/mutation.ts': "export const save = () => client.from('tickets').insert({ title: 'new' });",
    })
    expect(result.category('CLIENT_MUTATION')).toHaveLength(1)
    expect(result.status).toBe(1)
  })
  it('upsert de outra linha não é autorizado apenas por escrever user_id no payload', () => {
    const result = audit({ 'app/actions.ts': `'use server'; export async function save() { ${authenticated}
      return client.from('tickets').upsert({ id: 'foreign-row', user_id: user.id }, { onConflict: 'id' }); }` })
    expect(result.category('IDOR')).toHaveLength(1)
    expect(result.status).toBe(1)
  })
})

describe('contratos de schema verificáveis', () => {
  const schema = `CREATE TABLE tickets (id uuid PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE);
    ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;`
  it('exige índice e comportamento explícito de exclusão para FK', () => {
    const result = audit({ 'supabase/migrations/001.sql': schema.replace(' ON DELETE CASCADE', '') })
    expect(result.category('SQL_CONTRACT')).toHaveLength(1)
    expect(result.category('SQL_INDEX')).toHaveLength(1)
    expect(result.status).toBe(1)
  })
  it('aceita migration posterior com índice completo e não confunde coluna errada/índice parcial', () => {
    const result = audit({
      'supabase/migrations/001.sql': schema,
      'supabase/migrations/002.sql': 'CREATE INDEX ix ON tickets(user_id, id);',
    })
    expect(result.findings).toEqual([])
    expect(result.status).toBe(0)
    const partial = audit({ 'supabase/migrations/001.sql': schema + ' CREATE INDEX ix ON tickets(user_id) WHERE user_id IS NOT NULL;' })
    expect(partial.category('SQL_INDEX')).toHaveLength(1)
  })
  it('recusa índice removido e RLS desativado em migration posterior', () => {
    const result = audit({
      'supabase/migrations/001.sql': schema + ' CREATE INDEX ix ON tickets(user_id);',
      'supabase/migrations/002.sql': 'DROP INDEX ix; ALTER TABLE tickets DISABLE ROW LEVEL SECURITY;',
    })
    expect(result.category('SQL_INDEX')).toHaveLength(1)
    expect(result.category('SQL_CONTRACT')).toHaveLength(1)
  })
  it('RLS precisa de DDL real na tabela exata e pode ser ativado por migration posterior', () => {
    const missing = audit({ 'supabase/migrations/001.sql': 'CREATE TABLE "Tickets" (id uuid); ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;' })
    expect(missing.category('SQL_CONTRACT')).toHaveLength(1)
    const comments = audit({ 'supabase/migrations/001.sql': 'CREATE TABLE tickets (id uuid); -- ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;' })
    expect(comments.category('SQL_CONTRACT')).toHaveLength(1)
    const forward = audit({
      'supabase/migrations/001.sql': 'CREATE TABLE tickets (id uuid);',
      'supabase/migrations/002.sql': 'ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;',
    })
    expect(forward.category('SQL_CONTRACT')).toHaveLength(0)
  })
  it('ALTER com múltiplas cláusulas não esconde a desativação de RLS', () => {
    const result = audit({ 'supabase/migrations/001.sql': 'CREATE TABLE tickets (id uuid); ALTER TABLE tickets ENABLE ROW LEVEL SECURITY; ALTER TABLE tickets DISABLE ROW LEVEL SECURITY, ADD COLUMN title text;' })
    expect(result.category('SQL_CONTRACT')).toHaveLength(1)
    expect(result.status).toBe(1)
  })
  it('comentário e corpo de função não suprem índice de FK', () => {
    const result = audit({ 'supabase/migrations/001.sql': schema + `
      /* CREATE INDEX ix ON tickets(user_id); */
      CREATE FUNCTION example() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE NOTICE 'CREATE INDEX ix ON tickets(user_id);'; END $$;` })
    expect(result.category('SQL_INDEX')).toHaveLength(1)
  })
})
