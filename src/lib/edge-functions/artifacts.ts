import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptToken, encryptToken } from '@/lib/crypto'
import { functionArtifactVersionSchema, functionDeploySchema, type FunctionDeploy } from './contract'
import { FunctionError } from './policy'

interface ArtifactScope { ownerId: string; projectId: string; projectRef: string; environment: 'development' | 'production' }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export function sealFunctionArtifact(scope: ArtifactScope, bundle: FunctionDeploy, version: number): { encryptedBundle: string; bundleHash: string } {
  const data = JSON.stringify({ scope, version: z.number().int().positive().parse(version), bundle: functionDeploySchema.parse(bundle) })
  return { encryptedBundle: encryptToken(data), bundleHash: hash(data) }
}
export function openFunctionArtifact(scope: ArtifactScope, slug: string, version: number, encryptedBundle: string, bundleHash: string): FunctionDeploy {
  try {
    const plaintext = decryptToken(encryptedBundle)
    if (hash(plaintext) !== bundleHash) throw new Error('Hash mismatch')
    const record = z.object({ scope: z.object({ ownerId: z.string(), projectId: z.string(), projectRef: z.string(), environment: z.string() }).strict(), version: z.number().int().positive(), bundle: functionDeploySchema }).strict().parse(JSON.parse(plaintext))
    if (record.scope.ownerId !== scope.ownerId || record.scope.projectId !== scope.projectId || record.scope.projectRef !== scope.projectRef || record.scope.environment !== scope.environment || record.version !== version || record.bundle.slug !== slug || record.bundle.environment !== scope.environment) throw new Error('Scope mismatch')
    return record.bundle
  } catch { throw new FunctionError('Artefato anterior não pôde ser autenticado para este destino.') }
}
export function functionArtifactStore(client: SupabaseClient, { authorize, ...scope }: ArtifactScope & { authorize(): Promise<void> }) {
  const query = () => client.from('function_artifacts').select('encrypted_bundle,bundle_hash').eq('user_id', scope.ownerId).eq('project_id', scope.projectId).eq('target_ref', scope.projectRef).eq('environment', scope.environment)
  return {
    async history(slug: string) {
      await authorize()
      const result = await client.from('function_artifacts').select('version,created_at,bundle_hash').eq('user_id', scope.ownerId).eq('project_id', scope.projectId).eq('target_ref', scope.projectRef).eq('environment', scope.environment)
        .eq('slug', slug).order('version', { ascending: false }).limit(101)
      if (result.error) throw new FunctionError('Histórico protegido indisponível. Confira a migration 035.', 503)
      await authorize()
      return { versions: (result.data ?? []).slice(0, 100).map(row => functionArtifactVersionSchema.parse({ version: row.version, createdAt: row.created_at, hash: row.bundle_hash })), complete: (result.data?.length ?? 0) <= 100 }
    },
    async save(bundle: FunctionDeploy, version: number) {
      await authorize()
      const sealed = sealFunctionArtifact(scope, bundle, version)
      const result = await client.from('function_artifacts').upsert({ user_id: scope.ownerId, project_id: scope.projectId, target_ref: scope.projectRef, environment: scope.environment,
        slug: bundle.slug, version, encrypted_bundle: sealed.encryptedBundle, bundle_hash: sealed.bundleHash }, { onConflict: 'project_id,target_ref,environment,slug,version', ignoreDuplicates: true })
      if (result.error) throw new FunctionError('Função publicada, mas o artefato não foi persistido. Consulte a versão antes de repetir.', 503)
      const existing = await query().eq('slug', bundle.slug).eq('version', version).maybeSingle()
      if (existing.error || !existing.data || existing.data.bundle_hash !== sealed.bundleHash) throw new FunctionError('Versão já registrada com outro artefato ou persistência não confirmada.', 503)
    },
    async load(slug: string, version: number) {
      await authorize()
      const result = await query().eq('slug', slug).eq('version', version).maybeSingle()
      if (result.error || !result.data) throw new FunctionError('Este artefato não está no histórico protegido do Supremo. Versões externas não podem ser restauradas por este caminho.')
      await authorize()
      return openFunctionArtifact(scope, slug, version, result.data.encrypted_bundle, result.data.bundle_hash)
    },
  }
}
