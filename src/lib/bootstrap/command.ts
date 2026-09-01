import { CLI_PACKAGE } from './cli-package'

/**
 * Fonte única do comando de bootstrap que o usuário copia. Puro (sem deps de
 * servidor), pra a action e a página do projeto montarem exatamente o mesmo
 * comando — sem drift. Só o project-id (não é segredo) vai no comando; a
 * autorização é no navegador (device flow).
 *
 * O package vem de CLI_PACKAGE (canônico) — nunca hardcode um package que possa
 * não existir no npm. A URL é crua (sem markdown/colchetes).
 */
export function bootstrapCommand(projectId: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '')
  return `npx ${CLI_PACKAGE}@latest bootstrap ${projectId} --url ${base}`
}
