import 'server-only'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { boundedJson } from '../database-inspection/provider'
import { OperationError } from '../backend-operations/contract'
import type { StorageProvider } from './service'

/** Supabase Storage API exclusively. Never mutate storage tables using SQL.
 * https://supabase.com/docs/reference/javascript/storage-createbucket */
export function supabaseStorageProvider(resolve: () => Promise<{ projectRef: string; token: string }>): StorageProvider {
  const client = async () => {
    const initial = await resolve()
    if (!/^[a-z0-9]{1,64}$/.test(initial.projectRef)) throw new OperationError('Vínculo de armazenamento inválido.')
    const response = await fetch(`https://api.supabase.com/v1/projects/${initial.projectRef}/api-keys`, { headers: { Authorization: `Bearer ${initial.token}` }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12_000) })
    if (!response.ok) { await response.body?.cancel(); throw new OperationError('Não foi possível autorizar o armazenamento.', 502) }
    const keys = z.array(z.object({ name: z.string(), api_key: z.string() })).parse(await boundedJson(response, 32_000))
    const key = keys.find(item => item.name === 'service_role')?.api_key
    const current = await resolve()
    if (!key || current.projectRef !== initial.projectRef) throw new OperationError('O vínculo do armazenamento mudou ou a credencial não está disponível.')
    const url = `https://${current.projectRef}.supabase.co`
    const authorizedFetch: typeof fetch = async (input, init) => {
      const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
      if (target.origin !== url || !target.pathname.startsWith('/storage/v1/') || target.username || target.password) throw new OperationError('Destino de armazenamento fora do projeto autorizado.', 403)
      const before = await resolve()
      if (before.projectRef !== initial.projectRef) throw new OperationError('O vínculo do armazenamento mudou.')
      const result = await fetch(input, { ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) })
      try { if ((await resolve()).projectRef !== initial.projectRef) throw new OperationError('O vínculo do armazenamento mudou.') }
      catch (error) { await result.body?.cancel(); throw error }
      return result
    }
    const sdk = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: authorizedFetch } })
    return { storage: sdk.storage, url, key, authorizedFetch }
  }
  const check = (error: unknown) => { if (error) throw new OperationError('O armazenamento não confirmou a operação. Confira permissões, nome, tipo e tamanho do arquivo.', 502) }
  return {
    async buckets() { const { storage } = await client(); const result = await storage.listBuckets(); check(result.error); return (result.data ?? []).map(item => ({ id: item.id, name: item.name, public: item.public, file_size_limit: item.file_size_limit, allowed_mime_types: item.allowed_mime_types, created_at: item.created_at })) },
    async list(bucket, prefix, offset) { const { storage } = await client(); const result = await storage.from(bucket).list(prefix, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } }); check(result.error); return (result.data ?? []).map(item => ({ id: item.id, name: item.name, created_at: item.created_at, updated_at: item.updated_at, size: item.metadata?.size, contentType: item.metadata?.mimetype })) },
    async configure(bucket, settings, create) { const { storage } = await client(); const options = { public: settings.public, fileSizeLimit: settings.maxBytes, allowedMimeTypes: settings.mimeTypes }; const result = create ? await storage.createBucket(bucket, options) : await storage.updateBucket(bucket, options); check(result.error) },
    async deleteBucket(bucket) { const { storage } = await client(); check((await storage.deleteBucket(bucket)).error) },
    async upload(bucket, path, content, contentType) { const { storage } = await client(); check((await storage.from(bucket).upload(path, Buffer.from(content, 'base64'), { upsert: false, contentType })).error) },
    async verifyUpload(bucket, path, content, contentType) {
      const { url, key, authorizedFetch } = await client()
      const expected = Buffer.from(content, 'base64')
      const response = await authorizedFetch(`${url}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: { Authorization: `Bearer ${key}`, apikey: key } })
      if (!response.ok || !response.body || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== contentType.toLowerCase() || Number(response.headers.get('content-length') ?? 0) > expected.length) { await response.body?.cancel(); return false }
      const reader = response.body.getReader(), digest = createHash('sha256'); let bytes = 0
      try {
        for (;;) {
          const result = await reader.read()
          if (result.done) break
          bytes += result.value.byteLength
          if (bytes > expected.length || bytes > 512000) { await reader.cancel(); return false }
          digest.update(result.value)
        }
      } finally { reader.releaseLock() }
      await resolve()
      return bytes === expected.length && digest.digest('hex') === createHash('sha256').update(expected).digest('hex')
    },
    async remove(bucket, paths) { const { storage } = await client(); check((await storage.from(bucket).remove(paths)).error) },
    async exists(bucket, path) { const { storage } = await client(); const result = await storage.from(bucket).exists(path); check(result.error); return result.data ?? false },
    async download(bucket, path) {
      const { storage, url } = await client(); const result = await storage.from(bucket).createSignedUrl(path, 60, { download: true }); check(result.error)
      if (!result.data) throw new OperationError('Link do arquivo não confirmado.')
      const signed = new URL(result.data.signedUrl)
      if (signed.origin !== url || signed.username || signed.password || signed.hash || decodeURIComponent(signed.pathname) !== `/storage/v1/object/sign/${bucket}/${path}`) throw new OperationError('Link do arquivo não corresponde ao destino solicitado.')
      return result.data.signedUrl
    },
  }
}
