import { cliArtifact } from '@/lib/bootstrap/cli-artifact'
import { ENGINE_PROTOCOL } from '@/lib/backend-operations/catalog'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Public executable metadata; the CLI accepts it only from its authorized issuer. */
export function GET(): Response {
  const artifact = cliArtifact()
  return Response.json({ version: artifact.version, digest: artifact.digest,
    url: `/api/cli/${artifact.digest}.tgz`, queueProtocol: ENGINE_PROTOCOL.localQueue,
    protocol: ENGINE_PROTOCOL.version, minimumCli: ENGINE_PROTOCOL.minimumCli },
  { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}
