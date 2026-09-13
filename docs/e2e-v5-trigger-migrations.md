# E2E v5: ativação do histórico de despesas

O agente preparou uma migration de auditoria, mas `db migrate` recusou o bloco
PL/pgSQL `BEGIN` e o `EXECUTE FUNCTION` de seu gatilho como controle de transação
ou SQL dinâmico. A publicação do checkpoint não aplicava essa migration.

O servidor passa a reconhecer funções novas, qualificadas em `public` ou
`private`, sem argumentos, `RETURNS TRIGGER`, `LANGUAGE plpgsql`, explicitamente
`SECURITY INVOKER` e com `SET search_path = ''`. O gatilho precisa ser por linha,
em tabela `public`, e referenciar uma função inspecionada anteriormente na mesma
migration. O gatilho legado `public.set_updated_at()` permanece aceito.

Somente o `BEGIN` estrutural do corpo e a chamada estática reconhecida são
desconsiderados na busca de operações proibidas. O corpo inteiro continua sob
as verificações de segurança. SQL dinâmico, comandos destrutivos, controle de
transação, funções com privilégio elevado e gatilhos não inspecionados continuam
recusados. Formatos fora da gramática reconhecida exigem revisão. A migration
original é enviada ao banco sem reescrita.

A mudança é no servidor: projetos existentes que usam a API publicada recebem
a correção sem trocar CLI, scaffold, regras locais, dependências ou preview.
Uma migration anteriormente recusada precisa ser reenviada por `db migrate`.
O histórico de eventos começa na aplicação; não reconstrói eventos anteriores.

Validação: fixture da migration que motivou o incidente, regressões positivas
e adversariais, e `scripts/test-trigger-migrations.mts` em PostgreSQL descartável.
O teste real percorre a operação de migration autorizada, verifica idempotência,
criação, mudanças de situação, edição, exclusão, snapshots, responsável e RLS
entre contas. Também verifica negação de inserção direta e adulteração do histórico.
Esse teste faz parte do CI, junto com as provas existentes de banco.

Referência da semântica de permissões:
[PostgreSQL CREATE FUNCTION](https://www.postgresql.org/docs/current/sql-createfunction.html).
