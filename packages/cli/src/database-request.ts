import { z } from 'zod'
import { jobIdSchema, secretRequestOptionsSchema, type RequestedSecret } from './project-service-request'

export const databaseOperationSchema = z.enum(['status', 'migrate', 'anonymous-auth', 'inspect', 'query', 'logs', 'report',
  'secrets-request', 'secrets-status', 'cron-list', 'cron-history', 'cron-apply', 'cron-pause', 'cron-resume', 'cron-remove'])
export type DatabaseOperation = z.infer<typeof databaseOperationSchema>
const target = { environment: z.enum(['development', 'production', 'unknown']).optional() }
const bounded = { limit: z.number().int().min(1).max(200).default(50) }
const page = { offset: z.number().int().min(0).max(10_000).default(0) }
const logging = { minutes: z.number().int().min(1).max(1440).default(60),
  source: z.enum(['postgres', 'auth', 'api', 'functions', 'storage', 'realtime']).default('postgres'),
  level: z.enum(['all', 'error']).default('all') }
export const databaseReadOptionsSchema = z.object({ ...target, ...bounded,
  sql: z.string().min(1).max(12_000).optional(), offset: page.offset.optional(),
  table: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/).optional(),
  minutes: logging.minutes.optional(), source: logging.source.optional(), level: logging.level.optional(),
}).strict()
export type DatabaseOptions = Partial<z.infer<typeof databaseReadOptionsSchema>> & { requests?: RequestedSecret[]; jobId?: string | undefined }

/** Scope selectors never include URLs, refs or credentials. Server authority is
 * checked again for every operation, including production reads. */
export function parseDatabaseOptions(operation: DatabaseOperation, options: unknown = {}): DatabaseOptions {
  databaseOperationSchema.parse(operation)
  if (operation === 'secrets-request') return secretRequestOptionsSchema.parse(options)
  if (operation === 'secrets-status' || operation === 'cron-apply') return z.object({}).strict().parse(options)
  if (['cron-pause', 'cron-resume', 'cron-remove'].includes(operation)) return z.object({ jobId: jobIdSchema }).strict().parse(options)
  const cronPage = z.object({ ...target, ...page, limit: z.number().int().min(1).max(100).default(50) }).strict()
  if (operation === 'cron-list') return cronPage.parse(options)
  if (operation === 'cron-history') return cronPage.extend({ jobId: jobIdSchema.optional() }).parse(options)
  if (operation === 'status' || operation === 'migrate' || operation === 'anonymous-auth') return z.object({}).strict().parse(options)
  if (operation === 'query') return z.object({ ...target, ...bounded, ...page, sql: z.string().min(1).max(12_000) }).strict().parse(options)
  if (operation === 'logs' || operation === 'report') return z.object({ ...target, ...bounded, ...page, ...logging }).strict().parse(options)
  return z.object({ ...target, ...bounded, ...page, table: databaseReadOptionsSchema.shape.table }).strict().parse(options)
}

/** A small, literal shell form allows data diagnostics even during recovery.
 * Expansion/composition are rejected; SQL is never interpreted by the shell. */
export function isDatabaseReadCommand(command: string): boolean {
  if (!command.trim() || /[\\$`\r\n]/.test(command)) return false
  const tokens: string[] = []
  let token = '', quote: string | null = null
  for (const char of command.trim()) {
    if (quote) { if (char === quote) quote = null; else token += char; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (/[;&|<>(){}#]/.test(char)) return false
    if (/\s/.test(char)) { if (token) { tokens.push(token); token = '' }; continue }
    token += char
  }
  if (quote) return false
  if (token) tokens.push(token)
  if (tokens[0] === 'node' && /^(?:\.\/)?(?:tools|node_modules)\/supremo-cli\/dist\/bin\.js$/.test(tokens[1] ?? '')) tokens.splice(0, 2, 'supremo')
  if (tokens.shift() !== 'supremo') return false
  const family = tokens.shift()
  const requestedOperation = tokens.shift()
  if (family === 'secrets') {
    if (requestedOperation === 'status') return tokens.length === 0
    if (requestedOperation !== 'request') return false
    const names: string[] = [], fields: Record<string, string> = {}
    while (tokens.length) {
      const token = tokens.shift()!
      if (!token.startsWith('--')) { names.push(token); continue }
      if (!['--reason', '--target', '--environment'].includes(token) || !tokens.length || Object.hasOwn(fields, token)) return false
      fields[token] = tokens.shift()!
    }
    try {
      secretRequestOptionsSchema.parse({ requests: names.map(name => ({ name, description: fields['--reason'],
        target: fields['--target'], environment: fields['--environment'] ?? 'development' })) })
      return true
    } catch { return false }
  }
  if (family !== 'db' && family !== 'jobs') return false
  if (family === 'jobs' && !['list', 'history'].includes(requestedOperation ?? '')) return false
  const operation = family === 'jobs' ? `cron-${requestedOperation}` : requestedOperation
  if (!['status', 'inspect', 'query', 'logs', 'report', 'cron-list', 'cron-history'].includes(operation ?? '')) return false
  const options: Record<string, unknown> = {}
  while (tokens.length) {
    const flag = tokens.shift()!
    if (!flag.startsWith('--') && operation === 'query' && options.sql === undefined) { options.sql = flag; continue }
    if (!/^--(?:sql|environment|limit|offset|table|minutes|source|level|job-id)$/.test(flag) || !tokens.length || Object.hasOwn(options, flag === '--job-id' ? 'jobId' : flag.slice(2))) return false
    const key = flag === '--job-id' ? 'jobId' : flag.slice(2), value = tokens.shift()!
    options[key] = ['limit', 'offset', 'minutes'].includes(key) ? Number(value) : value
  }
  try { parseDatabaseOptions(operation as DatabaseOperation, options); return true } catch { return false }
}
