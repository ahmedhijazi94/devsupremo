/**
 * Guarda-corpos de SQL para as ferramentas de MCP.
 *
 * Não é um parser completo de SQL, e não pretende ser: é uma barreira contra
 * as formas conhecidas de um agente destruir ou abrir um banco por engano.
 *
 * A lição que desenhou este arquivo: a versão anterior casava a GRAFIA e não
 * o COMPORTAMENTO. Ela recusava `USING (true)` e deixava passar `USING (1=1)`,
 * que é a mesma coisa. Recusava `WITH CHECK (true)` em `FOR INSERT` e deixava
 * passar em `FOR ALL`, que inclui INSERT. Apagava o corpo das funções antes
 * de procurar padrão perigoso, então `EXECUTE 'ALTER TABLE ... DISABLE ROW
 * LEVEL SECURITY'` passava intacto. Toda regra aqui é escrita a partir do
 * efeito no banco, e cada furo conhecido tem um teste com o nome do furo.
 *
 * O que ele garante:
 *
 *  - execute_sql não faz DDL nem escrita, inclusive escrita escondida em CTE
 *  - nenhuma migration desliga RLS, mexe no schema auth ou dá acesso a anon
 *  - nenhuma policy de escrita existe sem amarrar a linha ao usuário logado
 *  - nenhuma policy é tautologia, escrita de qualquer forma
 *  - nenhuma função SECURITY DEFINER, que roda por cima do RLS
 *  - o corpo das funções é inspecionado, não ignorado
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

const DOLLAR_BODY = /\$([A-Za-z_]\w*)?\$([\s\S]*?)\$\1?\$/g

/** Remove comentários e colapsa espaço. Preserva todo o resto. */
function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Separa o SQL em duas visões, porque elas servem a perguntas diferentes.
 *
 * `text` é o SQL sem literais e sem corpo de função: é onde se procura
 * estrutura (qual comando, qual tabela) sem casar dentro de uma string.
 *
 * `bodies` é o conteúdo cru de cada função, COM os literais preservados —
 * é justamente dentro de uma string que mora o `EXECUTE 'ALTER TABLE ...'`.
 */
function split(sql: string): { text: string; bodies: string[] } {
  const withoutComments = stripComments(sql)
  const bodies: string[] = []

  const withoutBodies = withoutComments.replace(
    DOLLAR_BODY,
    (_all, _tag, body) => {
      bodies.push(String(body))
      return ' $$BODY$$ '
    },
  )

  const text = withoutBodies.replace(/'(?:[^']|'')*'/g, "''")

  return { text, bodies: bodies.map(stripComments) }
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
    pattern: /\bno\s+force\s+row\s+level\s+security\b/i,
    reason:
      'NO FORCE ROW LEVEL SECURITY isenta o dono da tabela do RLS. Não é permitido.',
  },
  {
    pattern: /\balter\s+table\s+[\w."]*\s*(auth|storage)\./i,
    reason: 'Alterar tabelas dos schemas auth ou storage não é permitido.',
  },
  {
    pattern:
      /\b(grant|alter\s+default\s+privileges)\b[^;]*\bto\s+(anon|public)\b/i,
    reason:
      'Conceder privilégio direto a anon ou public não é permitido. Use RLS policies.',
  },
  {
    // Uma função SECURITY DEFINER roda com o privilégio de quem a criou, e no
    // Supabase isso é o dono do schema — ou seja, por cima do RLS. Pior: o
    // Postgres concede EXECUTE a PUBLIC por padrão, então ela fica chamável
    // via /rest/v1/rpc/ com a anon key. É o caminho mais curto para vazar uma
    // tabela inteira sem tocar em nenhuma policy.
    pattern: /\bsecurity\s+definer\b/i,
    reason:
      'SECURITY DEFINER roda por cima do RLS e fica exposta em /rest/v1/rpc/ ' +
      'com a anon key. Use SECURITY INVOKER (padrão). Se a função precisa mesmo ' +
      'de privilégio elevado, ela não pertence ao schema public.',
  },
  {
    pattern:
      /\bpg_read_(server_)?file\b|\bpg_ls_dir\b|\bcopy\b[^;]*\bfrom\s+program\b/i,
    reason: 'Leitura do sistema de arquivos do banco não é permitida.',
  },
]

/** Só permitido quando allowDdl é verdadeiro. */
const DDL_KEYWORDS =
  /^\s*(create|alter|drop|truncate|grant|revoke|comment|reindex|vacuum|cluster)\b/i

/**
 * Escrita de dados. Diferente da versão anterior, procura em QUALQUER posição
 * da instrução — não só no começo. Escrita dentro de CTE (`WITH x AS (DELETE
 * ... RETURNING id) SELECT * FROM x`) é uma instrução que COMEÇA com WITH e
 * apaga a tabela inteira.
 */
const WRITE_ANYWHERE: Array<{ pattern: RegExp; verb: string }> = [
  { pattern: /\binsert\s+into\b/i, verb: 'INSERT' },
  { pattern: /\bupdate\s+[\w."]+\s+set\b/i, verb: 'UPDATE' },
  { pattern: /\bdelete\s+from\b/i, verb: 'DELETE' },
  { pattern: /\bmerge\s+into\b/i, verb: 'MERGE' },
  { pattern: /\btruncate\b/i, verb: 'TRUNCATE' },
  { pattern: /\bselect\s+into\b/i, verb: 'SELECT INTO' },
]

/**
 * Controle de transação e de sessão, bloqueados em execute_sql.
 *
 * A leitura é imposta pelo próprio Postgres, com a query rodando dentro de
 * `BEGIN READ ONLY`. Estas instruções são as que encerrariam ou afrouxariam
 * essa transação — sem elas, a garantia do banco não tem como ser desfeita.
 */
const SESSION_CONTROL =
  /^\s*(begin|start\s+transaction|commit|rollback|end|savepoint|release|set|reset|discard|do)\b/i

export function assertSafeSql(sql: string, options: SqlGuardOptions): void {
  const { text, bodies } = split(sql)

  if (!text) {
    throw new UnsafeSqlError('Query vazia.')
  }

  for (const rule of ALWAYS_FORBIDDEN) {
    if (rule.pattern.test(text)) {
      throw new UnsafeSqlError(rule.reason)
    }
    // O corpo da função é inspecionado com os literais intactos: é dentro de
    // uma string que mora o SQL dinâmico do EXECUTE.
    for (const body of bodies) {
      if (rule.pattern.test(body)) {
        throw new UnsafeSqlError(
          `${rule.reason} (encontrado dentro do corpo de uma função)`,
        )
      }
    }
  }

  const statements = splitStatements(text)

  if (!options.allowDdl) {
    for (const statement of statements) {
      if (DDL_KEYWORDS.test(statement)) {
        throw new UnsafeSqlError(
          'execute_sql é só para leitura. Use apply_migration para mudar o schema — ' +
            'ela versiona a migration no repositório antes de aplicar.',
        )
      }

      const write = WRITE_ANYWHERE.find((w) => w.pattern.test(statement))
      if (write) {
        throw new UnsafeSqlError(
          `execute_sql não escreve dados, e encontrei ${write.verb} nesta query. ` +
            'Escrita dentro de CTE continua sendo escrita. Faça a escrita pela ' +
            'aplicação, onde o RLS e a validação do servidor se aplicam.',
        )
      }

      if (SESSION_CONTROL.test(statement)) {
        throw new UnsafeSqlError(
          'execute_sql roda dentro de uma transação somente-leitura e não ' +
            'aceita controle de transação ou de sessão (BEGIN, COMMIT, SET, DO).',
        )
      }
    }
    return
  }

  assertPoliciesAreScoped(text)
  assertRlsOnNewTables(text)
}

// ─────────────────────────────────────────────────────────────
// Policies
// ─────────────────────────────────────────────────────────────

/** Comandos de policy que escrevem. Todos precisam amarrar a linha ao dono. */
const WRITE_COMMANDS = new Set(['insert', 'update', 'delete', 'all'])

/**
 * Lê a expressão entre parênteses a partir de um índice, respeitando
 * aninhamento. `USING (a = (SELECT b FROM c))` devolve tudo, não até o
 * primeiro fecha-parêntese.
 */
function readBalanced(text: string, openIndex: number): string | null {
  if (text[openIndex] !== '(') return null

  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    const char = text[i]
    if (char === '(') depth++
    else if (char === ')') {
      depth--
      if (depth === 0) return text.slice(openIndex + 1, i)
    }
  }
  return null
}

/** `true`, `1=1`, `2 > 1`: sempre verdadeiro, sempre libera a tabela. */
function isTautology(expression: string): boolean {
  const e = expression.toLowerCase().replace(/[()\s]/g, '')

  if (e === 'true') return true
  // Identidade numérica ou textual: 1=1, 'x'='x', 2>1.
  if (/^(\d+)=\1$/.test(e)) return true
  if (/^''=''$/.test(e)) return true
  if (/^(\d+)>(\d+)$/.test(e)) {
    const match = /^(\d+)>(\d+)$/.exec(e)
    if (match?.[1] && match[2] && Number(match[1]) > Number(match[2]))
      return true
  }
  return false
}

/**
 * Tautologia usada como operando de OR anula tudo que vem antes dela:
 * `auth.uid() = user_id OR true` é `true`. Diferente de `is_public = true
 * AND auth.uid() = user_id`, onde o literal é um valor de coluna legítimo —
 * por isso a busca é pelo operando de OR, não pela palavra solta.
 */
function hasOrTautology(expression: string): boolean {
  const e = expression.toLowerCase().replace(/\s+/g, ' ')
  return (
    /\bor\s+\(?\s*(true|(\d+)\s*=\s*\2)\s*\)?/.test(e) ||
    /\(?\s*(true|(\d+)\s*=\s*\2)\s*\)?\s+or\b/.test(e)
  )
}

function mentionsAuthenticatedUser(expression: string): boolean {
  return /\bauth\s*\.\s*(uid|jwt)\s*\(/i.test(expression)
}

/**
 * Toda policy precisa amarrar a linha a alguém.
 *
 * Escrita (INSERT/UPDATE/DELETE/ALL) exige referência a auth.uid() — sem
 * isso não existe noção de dono e qualquer autenticado escreve na linha de
 * qualquer outro. Leitura pode ser aberta por um predicado de coluna
 * (`published = true` num blog é uma decisão legítima), mas nunca por uma
 * tautologia, que não é decisão nenhuma.
 */
function assertPoliciesAreScoped(text: string): void {
  const policyRe =
    /\b(create|alter)\s+policy\s+("?[\w\s-]+"?)\s+on\s+([\w."]+)/gi

  let match: RegExpExecArray | null
  while ((match = policyRe.exec(text)) !== null) {
    const policyName = (match[2] ?? '').replace(/"/g, '').trim()
    const table = bareTableName(match[3] ?? '')
    if (!table) continue

    // A cláusula vai do nome da policy até o fim da instrução.
    const rest = text.slice(match.index).split(';')[0] ?? ''

    const commandMatch = /\bfor\s+(all|select|insert|update|delete)\b/i.exec(
      rest,
    )
    const command = (commandMatch?.[1] ?? 'all').toLowerCase()

    for (const clause of ['using', 'with check'] as const) {
      const clauseRe = new RegExp(
        `\\b${clause.replace(' ', '\\s+')}\\s*\\(`,
        'i',
      )
      const found = clauseRe.exec(rest)
      if (!found) continue

      const openIndex = found.index + found[0].length - 1
      const expression = readBalanced(rest, openIndex)
      if (expression === null) continue

      const label = `${clause.toUpperCase()} da policy "${policyName}" em ${table}`

      if (isTautology(expression) || hasOrTautology(expression)) {
        throw new UnsafeSqlError(
          `${label} é sempre verdadeira (${expression.trim()}), o que libera a ` +
            `tabela inteira para qualquer requisição. Escreva a condição de dono, ` +
            `por exemplo: auth.uid() = user_id`,
        )
      }

      const isWriteClause =
        clause === 'with check' || WRITE_COMMANDS.has(command)

      if (isWriteClause && !mentionsAuthenticatedUser(expression)) {
        throw new UnsafeSqlError(
          `${label} não referencia auth.uid(). Policy de escrita sem dono deixa ` +
            `qualquer usuário autenticado gravar na linha de qualquer outro. ` +
            `Use auth.uid() = user_id, ou uma subconsulta que chegue até auth.uid().`,
        )
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Tabelas
// ─────────────────────────────────────────────────────────────

/**
 * Toda tabela criada numa migration precisa sair com RLS ligado.
 * A regra vale para tabelas em `public` — schemas internos do Postgres e
 * extensões ficam de fora.
 */
function assertRlsOnNewTables(text: string): void {
  const createdTables = new Set<string>()

  const createRe = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi
  let match: RegExpExecArray | null

  while ((match = createRe.exec(text)) !== null) {
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

  while ((match = rlsRe.exec(text)) !== null) {
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
              `  CREATE POLICY "${t}_owner_only" ON ${t} FOR ALL USING (auth.uid() = user_id);`,
          )
          .join('\n') +
        `\nO teste de RLS destas tabelas é gerado automaticamente no mesmo PR.`,
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

function splitStatements(text: string): string[] {
  return text
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}
