import { tokenizeForeignKeySql } from './foreign-key-contract'

/** Lexical inspection view only. Never execute this text. SQL literals and
 * nested comments cannot supply commands. Function bodies are inspected as SQL;
 * dollar-quoted application values remain values. Ambiguous syntax fails closed. */
export function executableMigrationSql(sql: string): string {
  let statement: string[] = []
  const output: string[] = []
  for (const token of tokenizeForeignKeySql(sql)) {
    if (token.kind === 'literal') {
      const functionBody =
        /^create (?:or replace )?function\b/.test(statement.join(' ')) &&
        statement.at(-1) === 'as'
      output.push(functionBody ? executableMigrationSql(token.value) : "''")
    } else if (token.kind === 'body') {
      const functionBody = /^create (?:or replace )?function\b/.test(
        statement.join(' '),
      )
      output.push(functionBody ? executableMigrationSql(token.value) : "''")
    } else {
      const value =
        token.kind === 'identifier'
          ? `"${token.value.replaceAll('"', '""')}"`
          : token.value
      output.push(value)
      if (token.value === ';') statement = []
      else statement.push(value)
    }
  }
  // Keep qualified names and routine calls recognizable by the existing guard.
  return output
    .join(' ')
    .replace(/\s*\.\s*/g, '.')
    .replace(/\b([a-z_][a-z_0-9]*)\s+\(/gi, '$1(')
}
