/** Comandos explícitos; entrada desconhecida nunca inicia um serviço. */
export const KNOWN_COMMANDS = ['bootstrap', 'checkpoint', 'daemon', 'sync', 'db', 'turn', 'host'] as const

/** O primeiro token de argv é um comando conhecido, uma opção global, ou vazio? */
export function isKnownOrGlobal(firstArg: string | undefined): boolean {
  if (!firstArg) return true // sem args: mostra ajuda
  if (firstArg.startsWith('-')) return true // opção global, ex.: --version/--help
  return (KNOWN_COMMANDS as readonly string[]).includes(firstArg)
}

/** Mensagem do comando desconhecido — inclui a dica de versão desatualizada. */
export function unknownCommandMessage(attempted: string): string {
  const listed = KNOWN_COMMANDS.join(', ')
  return (
    `✗ Comando desconhecido: "${attempted}".\n` +
    `  Comandos disponíveis: ${listed}\n` +
    `  Se você atualizou o Supremo recentemente, sua CLI local pode estar\n` +
    `  desatualizada (o \`npx\` às vezes reusa uma versão em cache) — rode de novo\n` +
    `  com \`npx --yes supremo-cli@latest ${attempted} ...\`.`
  )
}
