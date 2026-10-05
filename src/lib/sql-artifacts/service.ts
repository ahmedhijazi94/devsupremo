import { createHash } from 'node:crypto'
import { SqlArtifactError, type SqlArtifact } from './contract'

export const artifactDigest = (content: string): string => createHash('sha256').update(content).digest('hex')
export interface SqlArtifactPort {
  authorize(): Promise<void>
  save(state: SqlArtifact['state'], message: string, types?: NonNullable<SqlArtifact['types']>): Promise<SqlArtifact>
  execute(): Promise<'succeeded' | 'uncertain' | 'failed' | 'pending'>
  history(): Promise<'matching' | 'absent' | 'conflict'>
  types(): Promise<string>
}
/** The common operation receipt owns dispatch. Reconciliation is read-only:
 * an absent history row after an uncertain request never authorizes a resend. */
export async function advanceSqlArtifact(artifact: SqlArtifact, port: SqlArtifactPort): Promise<SqlArtifact> {
  await port.authorize()
  if (['succeeded', 'failed', 'conflict'].includes(artifact.state)) return artifact
  if (!['materialized', 'applying', 'applied', 'uncertain'].includes(artifact.state)) throw new SqlArtifactError('Arquivo ainda não confirmado no projeto; banco preservado.')
  if (artifact.state === 'materialized') {
    artifact = await port.save('applying', 'Migration registrada no projeto; aplicação em andamento.')
    const result = await port.execute()
    if (result === 'failed') return port.save('failed', 'Autorização ou preparação recusada antes do envio. Migration preservada.')
    if (result === 'pending') return artifact
  }
  const history = await port.history()
  if (history === 'conflict') return port.save('conflict', 'O histórico contém conteúdo diferente para esta versão; nenhuma repetição enviada.')
  if (history !== 'matching') return port.save('uncertain', 'Aplicação ainda não confirmada no histórico; não será repetida automaticamente.')
  artifact = await port.save('applied', 'Banco e histórico confirmados; aguardando os tipos versionados.')
  if (artifact.types) return artifact
  const content = await port.types()
  return port.save('applied', 'Banco confirmado; tipos gerados aguardando gravação no projeto.', {
    path: artifact.path.replace('supabase/migrations/', 'supabase/types/').replace(/\.sql$/, '.types.ts'), content, digest: artifactDigest(content),
  })
}
export function assertMaterialization(artifact: SqlArtifact, digest: string): void {
  if (digest !== artifact.digest || artifactDigest(artifact.content) !== digest) throw new SqlArtifactError('Conteúdo materializado diverge da migration preparada.')
}
