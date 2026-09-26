import { createHash, createHmac } from 'node:crypto'
import { z } from 'zod'

export const scheduledFunctionSlug = z.string().regex(/^[a-z][a-z0-9_-]{0,63}(?![\s\S])/)
const scalar = z.union([z.string().max(1000).refine(value => !value.includes('\0')), z.number().finite(), z.boolean(), z.null()])
export const scheduledFunctionAction = z.object({
  type: z.literal('function'), slug: scheduledFunctionSlug,
  body: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), scalar)
    .refine(value => Object.keys(value).length <= 16 && !Object.keys(value).some(key => /secret|token|password|authorization|api.?key/i.test(key)), 'Credenciais não pertencem ao manifesto de jobs.').default({}),
}).strict()
export function scheduledFunctionNames(projectId: string, slug: string) {
  z.string().uuid().parse(projectId); scheduledFunctionSlug.parse(slug)
  const digest = createHash('sha256').update(`${projectId}:${slug}`).digest('hex').slice(0, 24)
  return { vault: `supremo:cron:${projectId}:${slug}`, environment: `SUPREMO_CRON_${digest.toUpperCase()}` }
}
export function cronSignature(secret: string, timestamp: string, invocationId: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${invocationId}.${body}`).digest('hex')
}
/** The generated function must validate these headers before all business work.
 * OPTIONS is only a signature probe. Real calls use POST and the original body. */
export const cronHandlerSource = `export async function verifyScheduledRequest(request: Request, secret: string | undefined) {
  const timestamp = request.headers.get('x-supremo-cron-timestamp') || '';
  const invocationId = request.headers.get('x-supremo-cron-id') || '';
  const signature = request.headers.get('x-supremo-cron-signature') || '';
  if (!secret || !/^\\d{10,12}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^[a-f0-9-]{36}$/.test(invocationId) || !/^[a-f0-9]{64}$/.test(signature)) return null;
  if (request.method !== 'POST' && request.method !== 'OPTIONS') return null;
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  if (reader) {
    try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 32768) { await reader.cancel(); return null; } chunks.push(value); } }
    catch { return null; } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body: string; try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signatureBytes = Uint8Array.from(signature.match(/../g)!, byte => parseInt(byte, 16));
  if (!await crypto.subtle.verify('HMAC', key, signatureBytes, new TextEncoder().encode(timestamp + '.' + invocationId + '.' + body))) return null;
  return { invocationId, body, probe: request.method === 'OPTIONS' };
}`

/** A ready authentication boundary, with no invented business success. */
export function scheduledFunctionScaffold(projectId: string, slug: string): string {
  const { environment } = scheduledFunctionNames(projectId, slug)
  return `${cronHandlerSource}

Deno.serve(async (request: Request) => {
  const verified = await verifyScheduledRequest(request, Deno.env.get('${environment}'));
  if (!verified) return Response.json({ error: 'Assinatura inválida.' }, { status: 401 });
  if (verified.probe) return new Response(null, { status: 204 });
  // Antes de qualquer efeito, valide o JSON de verified.body no servidor.
  // Use verified.invocationId como chave única de idempotência durável no banco.
  // Implemente a tarefa; retorne sucesso apenas quando o trabalho for concluído.
  return Response.json({ error: 'Tarefa agendada ainda não implementada.' }, { status: 501 });
});
`
}
