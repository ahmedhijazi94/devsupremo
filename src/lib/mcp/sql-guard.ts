/**
 * Guarda-corpos de SQL para as ferramentas de MCP.
 *
 * Não é um parser completo de SQL, e não pretende ser: é uma barreira contra
 * as formas conhecidas de um agente destruir ou abrir um banco por engano.
 * O que ele garante:
 *
 *  - execute_sql não faz DDL nem escrita destrutiva
 *  - nenhuma migration desliga RLS, mexe no schema auth ou dá permissão a anon
 *  - toda tabela criada numa migration sai com RLS ligado
 *
 * Erros aqui são de recusa, não de sanitização. Nada é reescrito em silêncio.
 */

export class UnsafeSqlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeSqlError'
  }
}

export interface SqlGuardOptions {
  /** DDL é permitido apenas em apply_migration. */
  allowDdl: boolean
}

/** Remove comentários e literais para não casar padrões dentro de strings. */
function normalize(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\$\$[\s\S]*?\$\$/g, ' $$BODY$$ ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Proibido em qualquer contexto, migration incluída. */
const ALWAYS_FORBIDDEN: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\bdrop\s+database\b/i,
    reason: 'DROP DATABASE nunca é permitido.',
  },
  {
    pattern: /\bdrop\s+schema\s+(public|auth|storage)\b/i,
    reason: 'Remover os schemas public, auth ou storage nunca é permitido.',
  },
  {
    pattern: /\bdisable\s+row\s+level\s+security\b/i,
    reason:
      'Desligar RLS não é permitido. Se a policy está errada, corrija a policy.',
  },
  {
    pattern: /\balter\s+table\s+[\w."]*\s*(auth|storage)\./i,
    reason: 'Alterar tabelas dos schemas auth ou storage não é permitido.',
  },
  {
    pattern: /\b(grant|alter\s+default\s+privileges)\b[^;]*\bto\s+(anon|public)\b/i,
    reason:
      'Conceder privilégio direto a anon ou public não é permitido. Use RLS policies.',
  },
  {
    pattern: /\bcreate\s+policy\b[^;]*\busing\s*\(\s*true\s*\)/i,
    reason:
      'Policy com USING (true) libera a tabela inteira. Escreva a condição de dono.',
  },
  {
    pattern:
      /\bcreate\s+policy\b[^;]*\bfor\s+insert\b[^;]*\bwith\s+check\s*\(\s*true\s*\)/i,
    reason:
      'INSERT com WITH CHECK (true) permite forjar linha em nome de outro usuário.',
  },
  {
    pattern: /\bpg_read_(server_)?file\b|\bpg_ls_dir\b|\bcopy\b[^;]*\bfrom\s+program\b/i,
    reason: 'Leitura do sistema de arquivos do banco não é permitida.',
  },
]

/** Só permitido quando allowDdl é verdadeiro. */
const DDL_KEYWORDS =
  /^\s*(create|alter|drop|truncate|grant|revoke|comment|reindex|vacuum|cluster)\b/i

/** Escrita de dados: bloqueada em execute_sql. */
const DML_WRITE_KEYWORDS = /^\s*(insert|update|delete|merge|upsert)\b/i

export function assertSafeSql(sql: string, options: SqlGuardOptions): void {
  const normalized = normalize(sql)

  if (!normalized) {
    throw new UnsafeSqlError('Query vazia.')
  }

  for (const rule of ALWAYS_FORBIDDEN) {
    if (rule.pattern.test(normalized)) {
      throw new UnsafeSqlError(rule.reason)
    }
  }

  const statements = splitStatements(normalized)

  if (!options.allowDdl) {
    for (const statement of statements) {
      if (DDL_KEYWORDS.test(statement)) {
        throw new UnsafeSqlError(
          'execute_sql é só para leitura. Use apply_migration para mudar o schema — ' +
            'ela versiona a migration no repositório antes de aplicar.'
        )
      }
      if (DML_WRITE_KEYWORDS.test(statement)) {
        throw new UnsafeSqlError(
          'execute_sql não escreve dados. Faça a escrita pela aplicação, ' +
            'onde o RLS e a validação do servidor se aplicam.'
        )
      }
    }
    return
  }

  assertRlsOnNewTables(normalized)
}

/**
 * Toda tabela criada numa migration precisa sair com RLS ligado.
 * A regra vale para tabelas em `public` — schemas internos do Postgres e
 * extensões ficam de fora.
 */
function assertRlsOnNewTables(normalized: string): void {
  const createdTables = new Set<string>()

  const createRe =
    /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi
  let match: RegExpExecArray | null

  while ((match = createRe.exec(normalized)) !== null) {
    const raw = match[1]
    if (!raw) continue

    const name = bareTableName(raw)
    if (!name) continue
    createdTables.add(name)
  }

  if (createdTables.size === 0) return

  const rlsEnabled = new Set<string>()
  const rlsRe =
    /\balter\s+table\s+(?:if\s+exists\s+)?([\w."]+)\s+enable\s+row\s+level\s+security/gi

  while ((match = rlsRe.exec(normalized)) !== null) {
    const raw = match[1]
    if (!raw) continue
    const name = bareTableName(raw)
    if (name) rlsEnabled.add(name)
  }

  const missing = [...createdTables].filter((t) => !rlsEnabled.has(t))

  if (missing.length > 0) {
    throw new UnsafeSqlError(
      `Tabela(s) sem RLS: ${missing.join(', ')}. ` +
        `Toda tabela nova precisa de:\n` +
        missing
          .map(
            (t) =>
              `  ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;\n` +
              `  CREATE POLICY "${t}_owner_only" ON ${t} FOR ALL USING (auth.uid() = user_id);`
          )
          .join('\n') +
        `\nInclua também o teste que prova que outro usuário não lê essas linhas.`
    )
  }
}

function bareTableName(raw: string): string | null {
  const cleaned = raw.replace(/"/g, '').toLowerCase()
  const parts = cleaned.split('.')
  const schema = parts.length > 1 ? parts[0] : 'public'
  const table = parts[parts.length - 1]

  if (!table) return null
  // Só exigimos RLS no schema da aplicação.
  if (schema !== 'public') return null

  return table
}

function splitStatements(normalized: string): string[] {
  return normalized
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}
