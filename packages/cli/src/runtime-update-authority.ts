import { z } from 'zod'
import { readProjectConfig } from './daemon'
import { deviceIssuer, readDeviceSecret } from './device-identity'
import { resolveKeychain } from './keychain'
import { runtimeCandidateSchema, type RuntimeCandidate, runtimeUpdateAuthoritySchema } from './runtime-update-contract'

async function request(projectId: string, issuer: string, operation: 'prepare' | 'authorize'): Promise<unknown> {
  const secret = readDeviceSecret(resolveKeychain(), projectId, issuer)
  if (!secret) throw new Error('Identidade indisponível para a atualização autorizada.')
  const response = await fetch(`${deviceIssuer(issuer)}/api/cli/candidate`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, deviceSecret: secret, operation }), signal: AbortSignal.timeout(operation === 'prepare' ? 60_000 : 10_000) })
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 8_000_000) throw new Error('Atualização não autorizada ou candidato indisponível; ferramentas preservadas.')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) { const result = await reader.read(); if (result.done) break; length += result.value.byteLength; if (length > 8_000_000) throw new Error('Candidato excede o limite.'); chunks.push(result.value) }
  } finally { await reader.cancel() }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}
export async function officialRuntimeCandidate(projectId: string, issuer: string): Promise<RuntimeCandidate> {
  const candidate = runtimeCandidateSchema.parse(await request(projectId, issuer, 'prepare'))
  if (candidate.projectId !== projectId) throw new Error('Candidato pertence a outro projeto.')
  return candidate
}
export async function authorizeRuntimeUpdate(cwd: string, authority: z.infer<typeof runtimeUpdateAuthoritySchema>): Promise<void> {
  const project = readProjectConfig(cwd)
  if (!project || project.projectId !== authority.projectId || deviceIssuer(project.apiBaseUrl) !== authority.issuer) throw new Error('Identidade local mudou desde o preparo da atualização.')
  const current = z.object({ projectId: z.literal(authority.projectId), revision: z.string().uuid() }).strict().parse(await request(authority.projectId, authority.issuer, 'authorize'))
  if (current.revision !== authority.revision) throw new Error('A autorização mudou. Prepare um novo candidato antes de substituir ferramentas.')
}
