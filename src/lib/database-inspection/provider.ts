import { sanitizeDiagnostic } from '@/lib/checkpoint/feedback'
import { readOnlyTransaction } from './sql'
import { isSensitiveIdentifier } from './sensitive'

export class InspectionError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message)
    this.name = 'InspectionError'
  }
}
export const RESPONSE_BYTES = 512_000

export function redactInspection(
  value: unknown,
  secrets: readonly string[] = [],
): { value: unknown; redacted: boolean; truncated: boolean } {
  let redacted = false
  let truncated = false
  const visit = (input: unknown, depth: number): unknown => {
    if (depth > 12) {
      truncated = true
      return '[TRUNCATED]'
    }
    if (typeof input === 'string') {
      let clean = input
      for (const secret of secrets)
        if (secret) clean = clean.replaceAll(secret, '[REDACTED]')
      clean = sanitizeDiagnostic(clean)
      if (input.length > 8000) truncated = true
      if (clean !== input) redacted = true
      return clean
    }
    if (Array.isArray(input)) {
      if (input.length > 200) truncated = true
      return input.slice(0, 200).map((item) => visit(item, depth + 1))
    }
    if (input && typeof input === 'object') {
      const entries = Object.entries(input)
      if (entries.length > 200) truncated = true
      return Object.fromEntries(
        entries.slice(0, 200).map(([key, item]) => {
          const cleanKey = String(visit(key, depth + 1))
          if (isSensitiveIdentifier(key)) {
            redacted = true
            return [cleanKey, '[REDACTED]']
          }
          return [cleanKey, visit(item, depth + 1)]
        }),
      )
    }
    return input
  }
  return { value: visit(value, 0), redacted, truncated }
}

/** Streaming cap applies even when the provider omits Content-Length. */
export async function boundedJson(
  response: Pick<Response, 'body' | 'headers'>,
  maximum = RESPONSE_BYTES,
): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel()
    throw new InspectionError(
      'Resposta excedeu o limite. Reduza o período, a projeção ou o número de linhas.',
      413,
    )
  }
  const reader = response.body?.getReader()
  if (!reader)
    throw new InspectionError(
      'Provedor devolveu resposta vazia; dados não confirmados.',
    )
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) {
        await reader.cancel()
        throw new InspectionError(
          'Resposta excedeu o limite. Reduza o período, a projeção ou o número de linhas.',
          413,
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new InspectionError(
      'Provedor devolveu JSON inválido; dados não confirmados.',
    )
  }
}

export interface InspectionProvider {
  query(sql: string): Promise<unknown[]>
  logs(parameters: URLSearchParams): Promise<unknown[]>
}

/** Credentials are re-resolved from fresh owner/project identity for every call.
 * API references: /docs/reference/api/v1-read-only-query and
 * /docs/reference/api/v1-get-project-logs. No privileged fallback. */
export function supabaseInspectionProvider(
  resolve: () => Promise<{ projectRef: string; token: string }>,
): InspectionProvider {
  const request = async (suffix: string, body?: { query: string }) => {
    const credentials = await resolve()
    if (!/^[a-z0-9_-]{1,64}$/.test(credentials.projectRef))
      throw new InspectionError('Vínculo do banco inválido.', 409)
    let response: Response
    try {
      response = await fetch(
        `https://api.supabase.com/v1/projects/${credentials.projectRef}/${suffix}`,
        {
          method: body ? 'POST' : 'GET',
          headers: {
            Authorization: `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(12_000),
        },
      )
    } catch {
      throw new InspectionError(
        'Provedor não respondeu no prazo ou a conexão falhou. Nenhum resultado foi confirmado.',
        504,
      )
    }
    if (!response.ok) {
      await response.body?.cancel()
      const status = response.status
      const explanation =
        status === 401 || status === 403
          ? 'Conta sem permissão ou autorização expirada para esta leitura.'
          : status === 404 || status === 405
            ? 'Endpoint de leitura não disponível para este projeto.'
            : status === 402
              ? 'Logs não disponíveis no plano atual.'
              : status === 429
                ? 'Limite do provedor atingido. Tente novamente mais tarde.'
                : 'Consulta recusada ou provedor indisponível. Verifique a sintaxe, as permissões e o estado do projeto.'
      throw new InspectionError(
        `${explanation} (HTTP ${status}). Nenhum fallback privilegiado foi utilizado.`,
        status === 429 ? 429 : 502,
      )
    }
    try {
      return await boundedJson(response)
    } catch (error) {
      if (error instanceof InspectionError) throw error
      throw new InspectionError(
        'Resposta do provedor interrompida; dados não confirmados.',
        504,
      )
    }
  }
  return {
    query: async (sql) => {
      const data = await request('database/query/read-only', {
        query: readOnlyTransaction(sql),
      })
      if (!Array.isArray(data))
        throw new InspectionError(
          'Resposta SQL inesperada; dados não confirmados.',
        )
      return data
    },
    logs: async (parameters) => {
      const data = await request(`analytics/endpoints/logs?${parameters}`)
      if (
        !data ||
        typeof data !== 'object' ||
        !('result' in data) ||
        !Array.isArray(data.result) ||
        ('error' in data && data.error)
      ) {
        throw new InspectionError(
          'Logs indisponíveis ou consulta incompatível com o provedor. Nenhum resultado foi confirmado.',
        )
      }
      return data.result
    },
  }
}
