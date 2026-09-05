# Prova obrigatória de isolamento por tabela — template 3.6.3

O gate de `npm run test:rls` cruza todas as migrations com as provas aprovadas
na execução atual do Vitest. Uma feature não ganha cobertura porque outra tabela
já tem teste. Não há nomes de features fixados no mecanismo.

## Contrato da suíte

Em um arquivo `supabase/*.rls.test.ts`, mantenha a preparação e limpeza da fixture
em `beforeAll`/`afterAll`, e registre dentro do `describe`:

```ts
import { isolationTest } from './isolation'

isolationTest('public.minha_tabela', async () => ({
  rowId: idDaLinhaDoDono,
  ownerAccessToken: sessaoDoDono.access_token,
  otherAccessToken: sessaoDeOutroUsuario.access_token,
}))
```

Para organizações, os usuários da fixture devem pertencer a organizações
separadas. `rowKey` permite indicar uma chave diferente de `id`.
O helper autentica as duas sessões, exige IDs de usuários diferentes, confirma
uma linha visível ao dono, verifica leitura/UPDATE/DELETE por terceiro e confirma
que a linha permanece acessível ao dono. Erro de rede ou fixture vazia falha.
Os testes específicos de INSERT, permissões de negócio e adesão a organizações
continuam necessários; este contrato é a cobertura mínima obrigatória por tabela.

A prova só entra no relatório quando o helper termina suas asserções e o teste
passa. Nome de teste, comentário, teste vazio, skip/todo, arquivo excluído e
relatório de execução anterior não satisfazem o gate. O runner cria um diretório
temporário exclusivo, força seu reporter e reprova qualquer erro da suíte.

## Detecção e bloqueio

O inventário lê o histórico completo de migrations, preserva schema e identifica
ownership por colunas de dono/tenant, referências a auth.users e condições de
policies. Dependências por foreign key propagam a exigência. Policies que delegam
a autorização a funções também exigem prova. Comentários, strings e corpos de
funções não viram tabelas fictícias. ALTER posterior e renomeação são considerados.

A detecção é conservadora: não basta remover uma policy antiga para apagar a
exigência de prova de uma tabela que continua existindo. DROP TABLE simples remove
a tabela do inventário. CREATE TABLE derivado/herdado ou não reconhecido falha
explicitamente em vez de produzir um inventário vazio. Este é um gate para o DDL
declarativo versionado; não é um interpretador PostgreSQL nem uma defesa contra
alguém que deliberadamente altere o próprio helper/reporter para falsificar provas.

O job RLS executa o gate quando mudam migrations, testes RLS, helper, runner,
configuração de testes, dependências ou workflow. O check obrigatório de qualidade
exige sucesso desse job explicitamente, inclusive no modo rápido/warn. Um job RLS
com falha ou ignorado por erro de dependência não vira um check obrigatório verde.
Quando essas áreas não mudam, o job continua leve. Nenhum novo comando foi adicionado
ao harness de edição; não há banco nem espera de CI adicionados ao hot path.

## Escopo e distribuição

O template inicial já registra provas para suas tabelas protegidas. Features
posteriores precisam fornecer fixtures adequadas às próprias constraints e relações.
Não se geram fixtures fictícias automaticamente para esconder a ausência de teste.

Os scripts entram no artefato do Supremo para serem copiados aos apps novos.
Projetos antigos precisam receber o helper/runner, atualizar `test:rls`, workflow
e registrar suas fixtures no contrato; testes antigos não fornecem automaticamente
a nova evidência de execução. Esta tarefa não aplicou nada ao checkout do E2E,
ao banco nem aos serviços locais/remotos. Preview, daemon, Restore e checkpoints
não foram alterados nesta correção.

## Validação

- Inventário lido na pasta E2E detectou profiles, audit_logs e a tabela da feature
  que faltava, sem consultar o banco e sem regra específica para ela.
- Testes executáveis usam Vitest real e o SDK Supabase sobre um servidor HTTP
  descartável, sem acessar banco remoto. Cobrem ausência, skip/todo, exclusão,
  placeholder com título válido, relatório antigo, prova de outra tabela,
  usuários iguais, fixture invisível, erro de backend e vazamentos de leitura/escrita.
- Helpers e suítes gerados para solo/team/public compilam em TypeScript strict.
- Build de produção com Webpack e auditoria de segurança estrita aprovados.
- Suíte completa final: 936 testes aprovados em 58 arquivos; cobertura de linhas
  91,47%, branches 93,27% e funções 94,14%. Typecheck sem erros; lint sem erros
  (cinco avisos preexistentes). Um timeout de teste antigo durante build concorrente
  não se repetiu na execução final sem build paralelo; nenhum timeout foi aumentado.
