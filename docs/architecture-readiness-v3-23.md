# Revisão de arquitetura e prontidão — 5 de setembro de 2026

A correção está na base do Supremo, scaffold 3.6.4. O projeto v3-23 foi consultado
para diagnóstico e não foi alterado. Preview, daemon, Restore e checkpoints
não receberam mudanças de implementação ou configuração.

## Causa da escolha indevida

As instruções geradas se contradiziam: toda Server Action precisava de sessão,
o template obrigatório de tabela incluía user_id e o documento de segurança
proibia qualquer policy irrestrita. A auditoria estática e a validação de SQL
repetiam essa generalização, pressionando o agente a inventar autenticação.

AGENTS.md, CLAUDE.md, SECURITY.md e ARCHITECTURE.md agora distinguem por feature:

- Envio público: persistência sem identidade, sem user_id; somente INSERT público.
- Dados privados sem login visível: identidade anônima persistente, ownership e RLS.
- Dados privados com conta: autenticação normal, ownership e RLS.

A existência de capability Auth não transforma uma feature pública em privada.
O gate genérico de isolamento foi preservado. A nova regressão executa o gate e
comprova que uma tabela pública write-only não pede usuários nem prova cross-user.
As provas continuam obrigatórias para tabelas privadas.

A auditoria reconhece INSERT direto em tabelas públicas write-only conhecidas.
O guard de migrations admite criação completa dessa tabela e GRANT INSERT mínimo;
não presume que uma policy avulsa autoriza abrir uma tabela existente. Ownership,
ALTER posterior, acesso público de leitura/alteração, outros schemas e permissões
extras possuem regressões negativas. DDL complexo continua exigindo revisão.

O exemplo SQL gerado também passa pela validação real de migrations automáticas.
RLS não substitui validação: o exemplo usa constraints e grants por coluna.
Uma API com INSERT público pode ser chamada diretamente; rate limiting apenas na
Server Action não cobre esse caminho. As instruções explicitam essa diferença.

## Por que o gate do v3-23 ficou vermelho

Fonte: [execução 33991587468, job Testes e cobertura](https://github.com/Hijaziia/v3-23/actions/runs/33991587468/job/101374664750#step:6:70).

Os 9 testes passaram, mas funções ficaram em 57,14% e branches em 72,72%, abaixo
do threshold de 80%. O formulário tinha fluxos não exercitados pelos testes de
renderização da página. Os avisos de act() não foram a causa do exit code 1.
Políticas RLS, tipos/lint/auditoria, vulnerabilidades e segredos passaram.
Build e E2E foram pulados por dependência do job de testes.

A documentação gerada dizia 70%, enquanto a configuração exigia 80% em todas as
métricas. A documentação foi alinhada aos 80% existentes e agora pede testes de
envio, validação, falha de backend, carregamento, sucesso e repetição. Nenhum
threshold foi reduzido; nenhum teste da feature foi excluído para liberar o gate.

## Validações concluídas

- Supremo: 969 testes aprovados em 59 arquivos, incluindo regressões dos três modelos.
- Cobertura: linhas/statements 91,54%; funções 94,17%; branches 93,21%.
- CLI: 204 testes aprovados em 14 arquivos, sem alterações na CLI.
- Typecheck: zero erros. Lint: zero erros, cinco avisos preexistentes.
- Auditoria estática estrita: zero achados. npm audit: zero vulnerabilidades.
- Build de produção com Webpack aprovado em cópia temporária isolada, preservando
  os artefatos e processos do preview existente. O build padrão com Turbopack nessa
  cópia não aceitou o symlink externo de node_modules; não houve mudança no bundler
  ou nas configurações versionadas do produto.
- Nenhuma mudança de preview, daemon, Restore, checkpoints ou código do v3-23.

A primeira execução restrita falhou ao abrir sockets de testes (EPERM); a suíte
passou com a permissão necessária. Uma execução também encontrou uma colisão
aleatória com o MySQL existente na porta 33060; o serviço foi preservado e a
execução seguinte passou. São limites do ambiente/fixtures, sem redução de gates.

## Limites da conclusão

A revisão considera uso pessoal do Supremo, sem acrescentar estrutura de SaaS.
A suíte local cobre as regras de autorização/escopo, migrations, provisionamento,
scaffold, integração e CLI existentes. Isso não equivale a um teste de carga nem
a uma certificação de todo código que agentes venham a gerar.

Esta tarefa não publicou o Supremo, não atualizou o scaffold de apps existentes
e não executou um novo ciclo remoto de criação de app até integração/deploy.
Para considerar a versão publicada validada, ainda é necessário publicar esta
base e executar esse ciclo com um app descartável, verificando INSERT persistente
e negação de SELECT/UPDATE/DELETE no Supabase real. A configuração e os dados de
produção não foram alterados. Alta escala exige metas de carga e medição do app
concreto; índices, paginação, limites, jobs e observabilidade são diretrizes,
não uma promessa de capacidade.
