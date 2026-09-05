import fs from 'node:fs'
import path from 'node:path'
import { readProjectConfig } from './daemon'
import { resolveKeychain } from './keychain'
import { requestDatabase } from './database-queue'

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
  const url = /^NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^\s"']+)/m.exec(env)?.[1]
  if (linked !== status.projectRef || url !== `https://${status.projectRef}.supabase.co`) {
    throw new Error('O banco do preview ou o link local diverge do development registrado. Nenhuma alteração foi enviada.')
  }
  return status.projectRef
}

export type DatabaseOperation = 'status' | 'migrate' | 'anonymous-auth'

export async function runDatabase(operation: DatabaseOperation, cwd = process.cwd()): Promise<unknown> {
  return requestDatabase(cwd, operation)
}

// Executado somente pelo daemon autorizado, nunca pelo processo do agente.
export async function runDatabaseDirect(operation: DatabaseOperation, cwd: string): Promise<unknown> {
  const config = readProjectConfig(cwd)
  if (!config) throw new Error('Execute o bootstrap para identificar o projeto.')
  const secret = resolveKeychain().get(config.projectId)
  if (!secret) throw new Error('O daemon não conseguiu acessar a autorização deste dispositivo. Verifique o keychain na máquina que executou o bootstrap.')
  const url = new URL('/api/database', config.apiBaseUrl)
  if (url.protocol !== 'https:' && !(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.protocol === 'http:')) {
    throw new Error('O endpoint do Supremo deve usar HTTPS.')
  }
  const request = async (op: string, extra: Record<string, unknown> = {}) => {
    const res = await fetch(url, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceSecret: secret, projectId: config.projectId, operation: op, ...extra }),
      signal: AbortSignal.timeout(op === 'status' ? 15_000 : 60_000),
    })
    const data = await res.json() as { error?: string }
    if (!res.ok) throw new Error(data.error ?? `Banco indisponível (HTTP ${res.status}).`)
    return data
  }
  const status = await request('status') as unknown as DatabaseStatus
  // Snapshot informativo, jamais usado como autorização para uma escrita futura.
  fs.writeFileSync(path.join(cwd, '.supremo/database.json'), JSON.stringify(status, null, 2) + '\n')
  if (operation === 'status') return status
  const expectedRef = validateLocalTarget(cwd, status)
  if (operation === 'anonymous-auth') return request(operation, { expectedRef })
  const directory = path.join(cwd, 'supabase/migrations')
  const migrations = fs.readdirSync(directory).filter((name) => name.endsWith('.sql')).sort().map((name) => ({
    path: `supabase/migrations/${name}`, content: fs.readFileSync(path.join(directory, name), 'utf8'),
  }))
  return request(operation, { expectedRef, migrations })
}
