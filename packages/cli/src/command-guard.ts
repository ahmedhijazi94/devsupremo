/**
 * Comandos reais registrados no `supremo` (fonte única — usada por `bin.ts` e
 * testável isoladamente, SEM importar `bin.ts`, que roda `program.parse()` no
 * topo do módulo — importá-lo executaria a CLI de verdade).
 *
 * POR QUE ISTO EXISTE: `mcp` é `isDefault: true` no commander (roda sem
 * precisar digitar "mcp"). O commander, ao ver um PRIMEIRO ARGUMENTO que não
 * bate com nenhum subcomando registrado, delega esse argumento (e o resto) ao
 * comando default — silenciosamente. Isso já causou um bug real em produção:
 * uma CLI publicada ANTES do "checkpoint"/"daemon" existirem recebeu
 * `checkpoint "resumo"`, não reconheceu "checkpoint" como comando, e o
 * commander rodou a ponte MCP (`mcp`) passando esses argumentos adiante — que
 * falhou com um erro sobre SUPREMO_URL completamente desconexo do que o
 * usuário pediu. `guardUnknownCommand` (em bin.ts) intercepta ANTES do parse:
 * comando desconhecido → erro claro (não a ponte MCP por engano).
 */
export const KNOWN_COMMANDS = ['connect', 'bootstrap', 'checkpoint', 'daemon', 'mcp'] as const

/** O primeiro token de argv é um comando conhecido, uma opção global, ou vazio? */
export function isKnownOrGlobal(firstArg: string | undefined): boolean {
  if (!firstArg) return true // sem args: cai no default (mcp) de propósito
  if (firstArg.startsWith('-')) return true // opção global, ex.: --version/--help
  return (KNOWN_COMMANDS as readonly string[]).includes(firstArg)
}

/** Mensagem do comando desconhecido — inclui a dica de versão desatualizada. */
export function unknownCommandMessage(attempted: string): string {
  const listed = KNOWN_COMMANDS.filter((c) => c !== 'mcp').join(', ')
  return (
    `✗ Comando desconhecido: "${attempted}".\n` +
    `  Comandos disponíveis: ${listed}\n` +
    `  Se você atualizou o Supremo recentemente, sua CLI local pode estar\n` +
    `  desatualizada (o \`npx\` às vezes reusa uma versão em cache) — rode de novo\n` +
    `  com \`npx --yes supremo-cli@latest ${attempted} ...\`.`
  )
}
