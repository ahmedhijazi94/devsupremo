import { cliArtifact } from './cli-artifact'

/** O comando instala a CLI desta versão do Supremo, identificada pelo conteúdo. */
export function bootstrapCommand(projectId: string, baseUrl: string): string {
  const url = new URL(baseUrl)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('URL inválida para bootstrap.')
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error('ID inválido para bootstrap.')
  const base = baseUrl.replace(/\/$/, '')
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`
  const artifact = `${base}/api/cli/${cliArtifact().digest}.tgz`
  return `npx --yes --package ${quote(artifact)} supremo bootstrap ${projectId} --url ${quote(base)}`
}
