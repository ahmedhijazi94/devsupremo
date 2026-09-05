import { cliArtifact } from '@/lib/bootstrap/cli-artifact'
export const runtime = 'nodejs'

/** Distribuição pública do executável; não contém nem concede credenciais. */
export async function GET(_request: Request, context: { params: Promise<{ digest: string }> }): Promise<Response> {
  const { digest } = await context.params
  const artifact = cliArtifact()
  if (digest !== `${artifact.digest}.tgz`) return new Response('Versão indisponível. Copie novamente o comando no Supremo.', { status: 404 })
  return new Response(new Uint8Array(artifact.bytes), { headers: {
    'Content-Type': 'application/gzip',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Disposition': 'attachment; filename="supremo-cli.tgz"',
    'X-Content-Type-Options': 'nosniff',
    ETag: `"${artifact.digest}"`,
  } })
}
