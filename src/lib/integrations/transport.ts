import 'server-only'
import { Resolver } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'
import { IntegrationError } from './error'
import { connectorOriginSchema, genericConnectorSchema, type GenericConnector } from './generic-contract'

export interface ProviderRequest { provider: 'resend' | 'stripe-test' | 'github' | 'generic'; contract?: GenericConnector; path: string; method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; credential: string; body?: string | undefined; idempotencyKey?: string | undefined }
export type ProviderTransport = (request: ProviderRequest) => Promise<unknown>
const origins = { resend: 'api.resend.com', 'stripe-test': 'api.stripe.com', github: 'api.github.com' } as const

/** Conservative IPv4-only egress; DNS results are pinned into the TLS request. */
export function publicProviderAddress(address: string): boolean {
  if (isIP(address) !== 4) return false
  const [a, b, c] = address.split('.').map(Number)
  return a !== undefined && b !== undefined && c !== undefined && a > 0 && a < 224 &&
    ![10, 127].includes(a) && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0 || b === 2 || b === 88 && c === 99)) &&
    !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) && !(a === 203 && b === 0 && c === 113)
}

export function assertProviderPath(input: ProviderRequest): void {
  const contract = input.provider === 'generic' ? genericConnectorSchema.parse(input.contract) : null
  const allowed = contract ? input.method === 'GET' && (input.path === contract.identity.path || contract.operations.some(operation => operation.method === 'GET' && operation.path === input.path || operation.verify && (operation.verify.idField ? new RegExp('^' + operation.verify.path + '/[A-Za-z0-9_-]{1,160}$').test(input.path) : operation.verify.path === input.path))) || contract.operations.some(operation => operation.method === input.method && operation.path === input.path) : input.provider === 'resend'
    ? input.method === 'POST' && input.path === '/emails' || input.method === 'GET' && /^\/emails\/[a-f0-9-]{36}$/.test(input.path)
    : input.provider === 'stripe-test'
      ? input.method === 'GET' && ['/v1/account', '/v1/balance'].includes(input.path) || input.method === 'POST' && input.path === '/v1/products' || input.method === 'GET' && /^\/v1\/products\/supremo_[a-f0-9]{40}$/.test(input.path)
      : input.method === 'GET' && (input.path === '/user' || /^\/repos\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(input.path))
  if (!allowed || /[\r\n]/.test(input.credential) || !input.credential || input.credential.length > 16384 || input.body && Buffer.byteLength(input.body) > 16000)
    throw new IntegrationError('Destino ou formato da chamada não autorizado.', 'forbidden')
}

/** Shared server-only primitive. Approval and account scope belong to the
 * connector; this layer enforces the actual public destination at TLS connect. */
export interface ProtectedJsonRequest { origin: string; path: string; method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; authorization?: { kind: 'bearer' | 'basic' | 'x-api-key'; value: string }; body?: string | undefined; contentType?: 'application/json' | 'application/x-www-form-urlencoded'; idempotencyKey?: string | undefined }
export async function protectedJsonRequest(input: ProtectedJsonRequest): Promise<unknown> {
  connectorOriginSchema.parse(input.origin)
  if (!/^\/[A-Za-z0-9/_.-]*$/.test(input.path) || input.path.includes('//') || input.path.split('/').some(part => part === '.' || part === '..') || input.body && Buffer.byteLength(input.body) > 16000 || input.authorization && (!input.authorization.value || /[\r\n]/.test(input.authorization.value) || input.authorization.value.length > 16384)) throw new IntegrationError('Chamada de rede fora do contrato.', 'forbidden')
  const hostname = new URL(input.origin).hostname
  let addresses: string[]
  const resolver = new Resolver({ timeout: 3000, tries: 1 })
  try { addresses = await resolver.resolve4(hostname) } catch { throw new IntegrationError('Não foi possível resolver o provedor.', 'unavailable') } finally { resolver.cancel() }
  if (!addresses.length || !addresses.every(publicProviderAddress)) throw new IntegrationError('Destino de rede do provedor não permitido.', 'forbidden')
  return new Promise((resolve, reject) => {
    const fail = (message: string, code: IntegrationError['code'], status?: number) => reject(new IntegrationError(message, code, status))
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'Supremo-integrations/1' }
    if (input.authorization) headers[input.authorization.kind === 'x-api-key' ? 'X-API-Key' : 'Authorization'] = input.authorization.kind === 'x-api-key' ? input.authorization.value : `${input.authorization.kind === 'basic' ? 'Basic' : 'Bearer'} ${input.authorization.value}`
    if (input.body) headers['Content-Type'] = input.contentType ?? 'application/json'
    if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey
    const outgoing = request({ hostname, port: 443, servername: hostname, family: 4,
      path: input.path, method: input.method, headers, signal: AbortSignal.timeout(12000),
      lookup: (_hostname, _options, callback) => callback(null, addresses[0]!, 4),
    }, incoming => {
      const status = incoming.statusCode ?? 0
      if (status < 200 || status >= 300) {
        incoming.resume()
        fail(status === 429 ? 'Limite do provedor atingido. Consulte a operação antes de tentar novamente.' : `Provedor recusou a operação (HTTP ${status}).`, status === 429 ? 'rate_limited' : input.method !== 'GET' && status >= 500 ? 'outcome_unknown' : 'unavailable', status)
        return
      }
      const chunks: Buffer[] = []; let size = 0
      incoming.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 128000) { incoming.destroy(); fail('Resposta do provedor excedeu o limite.', input.method !== 'GET' ? 'outcome_unknown' : 'unavailable') }
        else chunks.push(chunk)
      })
      incoming.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) }
        catch { fail('Resposta do provedor não pôde ser confirmada.', input.method !== 'GET' ? 'outcome_unknown' : 'unavailable') }
      })
      incoming.on('error', () => fail('Resposta do provedor interrompida.', input.method !== 'GET' ? 'outcome_unknown' : 'unavailable'))
    })
    outgoing.setTimeout(12000, () => outgoing.destroy(new Error('deadline')))
    outgoing.on('error', () => fail('Provedor não confirmou a operação no prazo.', input.method !== 'GET' ? 'outcome_unknown' : 'unavailable'))
    outgoing.end(input.body)
  })
}

export const protectedProviderRequest: ProviderTransport = async input => {
  assertProviderPath(input)
  return protectedJsonRequest({ origin: input.provider === 'generic' ? genericConnectorSchema.parse(input.contract).origin : `https://${origins[input.provider]}`,
    path: input.path, method: input.method, authorization: { kind: input.provider === 'generic' ? input.contract!.authorization : 'bearer', value: input.credential },
    body: input.body, idempotencyKey: input.idempotencyKey, contentType: input.provider === 'stripe-test' ? 'application/x-www-form-urlencoded' : 'application/json' })
}
