import fs from 'node:fs'
import path from 'node:path'
import { readProjectConfig } from './daemon'
import { resolveKeychain } from './keychain'
import { readDeviceSecret, deviceIssuer } from './device-identity'
import { requestDatabase } from './database-queue'
import { parseDatabaseOptions, type DatabaseOperation, type DatabaseOptions } from './database-request'
import { sanitizeDiagnostic } from '../../../src/lib/checkpoint/feedback'
import { z } from 'zod'
import { credentialResponse, readJobManifest, secretResponse, secretResponseSchema, selectRequestedSecrets } from './project-service-request'
import { readProjectStack } from './framework-runtime'
import { readFunctionDeployment } from './functions-request'
import { functionResponseSchema } from '../../../src/lib/edge-functions/contract'
export type { DatabaseOperation, DatabaseOptions } from './database-request'

export interface DatabaseStatus {
  environment: string
  projectRef: string | null
  automaticMigrations: boolean
}

export function validateLocalTarget(cwd: string, status: DatabaseStatus): string {
  if (status.environment !== 'development' || !status.automaticMigrations || !status.projectRef) {
    throw new Error('Banco não reconhecido como development pelo Supremo. Produção e ambiente desconhecido estão protegidos.')
  }
  const linked = fs.readFileSync(path.join(cwd, 'supabase/.temp/project-ref'), 'utf8').trim()
  const env = fs.readFileSync(path.join(cwd, '.env.local'), 'utf8')
  const start = readProjectStack(cwd) === 'tanstack-start-vite'
  const nextUrl = /^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^\s"']+)/m.exec(env)?.[1]
  const startUrl = /^VITE_SUPABASE_URL\s*=\s*["']?([^\s"']+)/m.exec(env)?.[1]
  if (nextUrl !== undefined && startUrl !== undefined && nextUrl !== startUrl) throw new Error('Variáveis públicas do banco divergem; nenhuma alteração foi enviada.')
  const url = start ? startUrl : nextUrl
  if (linked !== status.projectRef || url !== `https://${status.projectRef}.supabase.co`) {
    throw new Error('O banco do preview ou o link local diverge do development registrado. Nenhuma alteração foi enviada.')
  }
  return status.projectRef
}

export async function runDatabase(operation: DatabaseOperation, cwd = process.cwd(), options: DatabaseOptions = {}): Promise<unknown> {
  return requestDatabase(cwd, operation, options)
}

// Executado somente pelo daemon autorizado, nunca pelo processo do agente.
export async function runDatabaseDirect(operation: DatabaseOperation, cwd: string, options: DatabaseOptions = {}): Promise<unknown> {
  const checkedOptions = parseDatabaseOptions(operation, options)
  const config = readProjectConfig(cwd)
  if (!config) throw new Error('Execute o bootstrap para identificar o projeto.')
  const secret = readDeviceSecret(resolveKeychain(), config.projectId, config.apiBaseUrl)
  if (!secret) throw new Error('O daemon não conseguiu acessar a autorização deste dispositivo. Verifique o keychain na máquina que executou o bootstrap.')
  const issuer = deviceIssuer(config.apiBaseUrl)
  const url = new URL(`${issuer}/api/${operation.startsWith('secrets-') ? 'secrets' : operation.startsWith('functions-') ? 'functions' : 'database'}`)
  if (url.username || url.password || url.search || url.hash) throw new Error('Endpoint contém componentes não permitidos.')
  if (url.protocol !== 'https:' && !(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.protocol === 'http:')) {
    throw new Error('O endpoint do Supremo deve usar HTTPS.')
  }
  const request = async (op: string, extra: Record<string, unknown> = {}) => {
    const endpoint = op === 'status' && operation.startsWith('functions-') ? new URL(`${issuer}/api/database`) : url
    const res = await fetch(endpoint, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceSecret: secret, projectId: config.projectId, operation: op, ...extra }),
      signal: AbortSignal.timeout(op === 'status' ? 15_000 : 60_000),
    })
    const text = await res.text()
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Resposta de banco excede o limite; reduza paginação ou intervalo.')
    const data = JSON.parse(text) as { error?: string }
    if (!res.ok) throw new Error(sanitizeDiagnostic(data.error ?? `Banco indisponível (HTTP ${res.status}).`))
    return data
  }
  if (operation.startsWith('secrets-')) {
    const result = await request(operation.slice('secrets-'.length), operation === 'secrets-status' ? {} : { ...checkedOptions })
    if (operation === 'secrets-credentials' || operation === 'secrets-revoke-credential') return credentialResponse(result, config.projectId)
    const parsed = secretResponseSchema.extend({ projectId: z.literal(config.projectId) }).parse(result)
    const selected = operation === 'secrets-request' ? selectRequestedSecrets(parsed.requests, checkedOptions.requests ?? []).map(entry => entry.id)
      : operation === 'secrets-apply' || (operation === 'secrets-status' && checkedOptions.requestId) ? [checkedOptions.requestId!] : undefined
    if (operation === 'secrets-apply' && parsed.requests.find(entry => entry.id === checkedOptions.requestId)?.status !== 'fulfilled') {
      throw new Error('O servidor não confirmou a aplicação da credencial ao pedido solicitado.')
    }
    return secretResponse(result, config.projectId, issuer, selected)
  }
  const status = await request('status') as unknown as DatabaseStatus
  // Snapshot informativo, jamais usado como autorização para uma escrita futura.
  fs.writeFileSync(path.join(cwd, '.supremo/database.json'), JSON.stringify(status, null, 2) + '\n')
  if (operation === 'status') return status
  if (operation.startsWith('functions-')) {
    const target = z.object({ environment: z.enum(['development', 'production']),
      projectRef: z.string().regex(/^[a-z0-9_-]+$/).max(64) }).safeParse(status)
    if (!target.success || checkedOptions.environment !== target.data.environment) throw new Error('Funções exigem o ambiente explicitamente selecionado e confirmado pelo Supremo.')
    const deployment = operation === 'functions-deploy' ? readFunctionDeployment(cwd, checkedOptions) : checkedOptions
    const result = functionResponseSchema.safeParse(await request(operation, { ...deployment, expectedRef: target.data.projectRef, environment: target.data.environment }))
    if (!result.success || result.data.projectId !== config.projectId || result.data.projectRef !== target.data.projectRef || result.data.environment !== target.data.environment || result.data.operation !== operation) {
      throw new Error('Resposta da operação de funções não corresponde ao projeto e à solicitação autorizados.')
    }
    return result.data
  }
  if (operation.startsWith('auth-')) {
    const target = z.object({ environment: z.enum(['development', 'production', 'unknown']),
      projectRef: z.string().regex(/^[a-z0-9_-]+$/).max(64) }).parse(status)
    if (checkedOptions.environment && checkedOptions.environment !== target.environment) throw new Error('Ambiente solicitado diverge do banco vinculado; nenhuma operação enviada.')
    return request(operation, { ...checkedOptions, expectedRef: target.projectRef, environment: target.environment })
  }
  if (['inspect', 'query', 'logs', 'report', 'cron-list', 'cron-history'].includes(operation)) {
    const target = z.object({ environment: z.enum(['development', 'production', 'unknown']),
      projectRef: z.string().regex(/^[a-z0-9_-]+$/).max(64) }).parse(status)
    if (checkedOptions.environment && checkedOptions.environment !== target.environment) throw new Error('Ambiente solicitado diverge do banco vinculado; nenhuma consulta enviada.')
    // Reading requires fresh remote ownership and target validation, but never
    // a local .env file or a credential exposed to the agent.
    return request(operation, { ...checkedOptions, expectedRef: target.projectRef, environment: target.environment })
  }
  if (operation.startsWith('cron-')) {
    const target = z.object({ environment: z.enum(['development', 'production']), projectRef: z.string().regex(/^[a-z0-9_-]{1,64}$/) }).parse(status)
    if ((checkedOptions.environment ?? 'development') !== target.environment) throw new Error('Jobs exigem o ambiente explicitamente selecionado e confirmado pelo Supremo.')
    return request(operation, { ...checkedOptions, expectedRef: target.projectRef, environment: target.environment,
      ...(operation === 'cron-apply' ? { manifest: readJobManifest(cwd) } : {}) })
  }
  const expectedRef = validateLocalTarget(cwd, status)
  if (operation === 'anonymous-auth') return request(operation, { expectedRef })
  const directory = path.join(cwd, 'supabase/migrations')
  const migrations = fs.readdirSync(directory).filter((name) => name.endsWith('.sql')).sort().map((name) => ({
    path: `supabase/migrations/${name}`, content: fs.readFileSync(path.join(directory, name), 'utf8'),
  }))
  return request(operation, { expectedRef, migrations })
}
