/** Operational SQL guidance shared by both framework adapters, not an app migration. */
export const MIGRATION_GUIDE = `## Migrations no desenvolvimento

Leia este guia quando a feature precisar alterar o banco. Ele vale para Next e TanStack
Start. Os exemplos não são migrations prontas do seu app; adapte ao schema e ao acesso
exigido pelo pedido. Não crie tabelas, identidade ou histórico que o produto não pediu.

### Caminho oficial

1. Confira o schema relevante e o ambiente confirmado pelo preflight. Se houver dúvida,
   use \`node node_modules/supremo-cli/dist/bin.js db status\` ou \`db inspect\`.
   Um ref local ou arquivo de ambiente não comprova autorização de desenvolvimento.
2. Crie uma migration versionada em \`supabase/migrations/<14 dígitos>_<nome>.sql\`.
   Preserve migrations já aplicadas; correções posteriores usam uma nova migration.
   Toda tabela nova precisa de RLS, policies específicas, índices e constraints.
3. Aplique com \`node node_modules/supremo-cli/dist/bin.js db migrate\` pelo daemon
   autorizado. Development confirmado permite o fluxo automático. Aguarde a resposta
   dessa aplicação antes de usar o novo schema; isso não é aguardar testes ou CI.
4. Se houver recusa, corrija a causa apontada. Não repita SQL idêntico nem tente
   \`supabase db push\`, SQL direto, outra credencial ou mudança de ref para liberar.
   Produção, ambiente desconhecido e operações destrutivas seguem autorização própria.

### O que o caminho automático aceita

- DDL aditivo sujeito ao guard: tabelas com RLS, índices, constraints e policies.
- \`SECURITY DEFINER\` é bloqueado em qualquer schema, inclusive \`private\`.
  Renomear/mover a função não resolve. Use a sessão autenticada, \`SECURITY INVOKER\`
  e RLS. Não copie funções privilegiadas antigas da base como modelo de feature nova.
- Blocos PL/pgSQL automáticos têm uma exceção restrita para gatilhos: função NOVA em
  \`public\` ou no schema chamado exatamente \`private\`, sem argumentos, \`RETURNS TRIGGER\`,
  \`LANGUAGE plpgsql\`, \`SECURITY INVOKER\` e \`SET search_path = ''\`. Declare a função
  antes do gatilho na mesma migration; use \`FOR EACH ROW EXECUTE FUNCTION ...()\`.
  Não use \`CREATE OR REPLACE\` nem um schema inventado como \`expense_private\`.
  Preserve os grants de schemas existentes; restrinja EXECUTE somente na função nova.
- O corpo do gatilho pode atribuir campos de NEW ou inserir auditoria sob RLS.
  Não aceita SQL dinâmico, DDL, UPDATE/DELETE arbitrários, chamada de outra rotina
  com CALL/PERFORM nem mudança de sessão/transação. BEGIN/END só delimitam esse corpo.
  Funções de negócio com argumentos e blocos PL/pgSQL não recebem essa exceção.
- Para \`updated_at\`, reutilize \`public.set_updated_at()\` quando já existir na base.
  Para criar uma organização, confira orgs/memberships e suas policies antes de escrever
  a operação. Valide identidade e vínculo no servidor; não aceite adesão arbitrária ou
  papel administrativo enviado pelo navegador. Não improvise uma RPC privilegiada.
  Se uma operação realmente exigir um formato fora desse contrato, preserve a recusa
  e apresente a necessidade concreta de revisão pelo fluxo autorizado.

### Forma de um gatilho aceito

Este exemplo só mostra a forma permitida. Pressupõe uma tabela \`public.items\` com
RLS e coluna \`updated_at\`; não cria nem autoriza acesso a essa tabela. Use a função
de timestamp já existente quando ela atender. Para auditoria, mantenha também as
policies e provas descritas abaixo, em vez de copiar apenas esta função.

\`\`\`sql
CREATE SCHEMA IF NOT EXISTS private;
CREATE FUNCTION private.touch_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.touch_item() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER items_updated_at BEFORE UPDATE ON public.items
FOR EACH ROW EXECUTE FUNCTION private.touch_item();
\`\`\`

### Auditoria e provas para execução em background

Um gatilho INVOKER usa as permissões da sessão: INSERT no histórico precisa de grants
e policy compatíveis, sem liberar inserção direta de eventos falsos. Restrinja leitura
ao dono/organização e impeça UPDATE/DELETE do histórico pelo app. Vincule responsável
a \`auth.uid()\`; preserve antes/depois e a trilha quando o registro de origem for excluído.
Considere separadamente a exclusão de conta/organização e seus cascades.

Reutilize \`isolationTest\` de \`supabase/isolation.ts\` nas suítes \`*.rls.test.ts\` para
tabelas com ownership: dono acessa, outra conta não lê/altera/exclui e o original se
mantém. Acrescente provas de INSERT/papel e, se houver histórico, de evento legítimo,
negação de falsificação direta e preservação após exclusão. O helper genérico sozinho
não comprova essas regras adicionais. O worker/CI executa as provas; não abra um banco
de testes nem espere a suíte RLS antes de disponibilizar o preview. Prova não executada
permanece pendente, nunca aprovada. Os gates de integração continuam obrigatórios.
`
