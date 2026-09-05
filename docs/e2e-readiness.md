# Supremo: preparação para um novo E2E pessoal

Todos os apps existentes são descartáveis. O alvo é o gerador/orquestrador,
com desenvolvimento no agente do usuário, sem chat próprio e sem espera de CI
entre alterações.

## O que mudou

- Provisionamento de apps com login exige uma conta de banco. Falha de preparação
  ou migration impede concluir como pronto, preservando o ref para retomada.
- Todas as migrations do scaffold são aplicadas em ordem. Cada execução aplica e
  registra na mesma transação; retries consultam o histórico antes de executar SQL.
- A CLI acompanha o código em tools/supremo-cli, instalada por dependência local.
  Checkpoint, daemon e sync chamam o executável instalado diretamente, sem npx.
  Ao iniciar um daemon, a CLI atual prefere o executável do próprio projeto.
- O kit visual inclui Field, Select, Textarea, Alert, EmptyState, Skeleton, Table,
  Dialog e AppShell; botões têm loading, disabled e foco visível. Temas claro e
  escuro agora usam overrides CSS efetivos. Navegação e layouts são responsivos.
- DESIGN.md orienta personalização e estados das telas. /design-system permite
  inspeção em desenvolvimento; em produção normal retorna 404.
- Auditoria detecta imports estáticos transitivos que levam código privilegiado
  até Client Components, preservando a fronteira válida de Server Actions.
- Verify agora usa auditoria estrita também no modo rápido: um achado grave não
  pode aparecer apenas como aviso com exit code de sucesso. A etapa já existia;
  não foi adicionada espera de CI nem build obrigatório a cada edição visual.

## Evidências locais

- Supremo: 864 testes, 51 arquivos, cobertura de linhas 91,08%.
- CLI 1.3.0: 194 testes. Tipos e lint sem erros (cinco avisos antigos no Supremo).
- Builds do Supremo e do app gerado passaram com Webpack.
- A galeria respondeu HTTP 404 no servidor de produção normal.
- O build inclui o executável e o manifesto necessários à distribuição da CLI.
- O teste que inicia subprocessos ganhou tolerância de 15 segundos para evitar
  timeout intermitente; suas verificações e o comportamento do app não mudaram.

- Novo app team gerado e instalado com npm ci usando a CLI do próprio repositório.
- Checkpoint real, com registry inacessível e modo offline: 1010 ms nesta máquina,
  fila criada e árvore Git limpa. Medição única, não promessa universal de latência.
- Navegador: desktop e celular, claro/escuro distintos, formulário obrigatório,
  botão carregando, foco no diálogo, Tab, Escape e retorno ao botão de origem.
  Nenhum erro de runtime observado na galeria.
- PostgreSQL descartável: repetir migration não duplica execução; uma migration
  com erro desfaz DDL e não entra no histórico como concluída.
- Banco que demora ou recusa migration gera falha retomável, não sucesso falso.
- Teste executa verify quick com auditoria real e comprova bloqueio de policy insegura.

## Como iniciar o E2E externo com a versão correta

Execute/publique o Supremo a partir deste checkout. O comando de bootstrap exibido
agora aponta para um artefato da CLI servido pelo próprio Supremo, com o hash no
endereço. A instalação inicial não usa @latest nem depende de publicar a CLI no npm.
Depois da instalação, o projeto usa sua CLI local. A versão desta base é 1.3.0.
O teste de distribuição usa cache vazio e registry inacessível para provar esse caminho.
Este trabalho não fez deploy do Supremo; um deploy antigo continua exibindo o comando antigo.

O E2E externo deve criar um app descartável com login e dados por usuário, abrir
no agente, implementar uma funcionalidade, testar com dois usuários, salvar,
continuar editando durante o CI, retomar sessão e restaurar uma alteração.
A integração real GitHub/Supabase desse novo projeto ainda precisa ser executada;
os testes locais não a substituem. Não foram criados recursos remotos nesta tarefa.

## Limites

O supervisor do preview existente foi preservado; o preview usado na revisão foi
outro, descartável. A preparação inicial do banco pode esperar o provedor; isso
não coloca espera de CI no desenvolvimento diário. Falha persistente de provedor
continua exigindo retomada/correção, sem promessa de recuperação infinita.

A auditoria cobre padrões conhecidos e importações estáticas resolvíveis, não
prova toda arquitetura nem garante a segurança de qualquer código futuro. A
segurança por usuário/organização ainda depende das regras e testes de cada app.
