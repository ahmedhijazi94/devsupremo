import { z } from 'zod'
import { backendTurnContextSchema, type BackendTurnContext } from '../../../src/lib/checkpoint/turn-context'

const projectIdSchema = z.string().uuid()
// This is the wire format emitted by generateDeviceSecret: 32 random bytes, base64url.
const deviceSecretSchema = z.string().regex(/^sup_dev_ckpt_[A-Za-z0-9_-]{43}$/)

function contextEndpoint(apiBaseUrl: string): URL {
  const url = new URL(apiBaseUrl)
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('URL do backend não pode conter credenciais, query ou fragmento.')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Backend precisa HTTPS ou loopback.')
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/api/checkpoint/turn-context`
  return url
}

/** Only the validated project identity and device credential cross this boundary. */
export async function fetchTurnContext(
  projectId: string,
  apiBaseUrl: string,
  readSecret: (projectId: string) => string | null,
): Promise<BackendTurnContext> {
  const identity = projectIdSchema.parse(projectId)
  const endpoint = contextEndpoint(apiBaseUrl)
  const secret = readSecret(identity)
  if (!secret) throw new Error('Identidade do dispositivo indisponível.')
  const deviceSecret = deviceSecretSchema.parse(secret)
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: identity, deviceSecret }),
    // A 307/308 must never forward the device credential to a different destination.
    redirect: 'error', signal: AbortSignal.timeout(3000),
  })
  if (!response.ok) throw new Error(`Reconciliation HTTP ${response.status}`)
  const parsed = backendTurnContextSchema.parse(await response.json())
  if (parsed.projectId !== identity) throw new Error('Projeto remoto divergente.')
  return parsed
}
