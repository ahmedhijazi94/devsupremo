# Recuperação do E2E v4 — 08/09/2026

O E2E conduzido pelo usuário confirmou CRUD, persistência e separação visual entre
duas contas, edição de cor preservando formulário, consultas de dados/logs e
retomada após reiniciar o notebook. A seleção de uma porta livre foi aprovada pelo
usuário. Esses comportamentos não foram redesenhados nesta correção.

## Falhas encontradas e correções

- Os checkpoints locais existiam, mas `Test path must name a project test` impedia
  executar o contrato e publicar. O scaffold usa `app/` e `lib/`, enquanto o parser
  aceitava somente outros diretórios. CLI e gate RLS do CI agora usam uma única
  regra de caminhos relativos canônicos; traversal, arquivos externos, diretórios
  privados e provas inexistentes continuam bloqueados. O worker também exige um
  arquivo regular dentro do snapshot antes de executar qualquer prova.
- Contrato inválido aparece como falha de contrato, não como dependência externa.
  Integridade da base de validação continua uma falha de segurança.
- O histórico recebe somente códigos de diagnóstico permitidos associados ao
  projeto, dispositivo, checkpoint, SHA e revisão. Mostra etapa, causa e orientação;
  logs e caminhos ficam locais. Essa informação não pode aprovar um checkpoint nem
  substituir evidência mais recente do GitHub.
- O aviso de secrets atribuía qualquer erro à migration024. Agora distingue
  estrutura/cache, permissão, autenticação e indisponibilidade sem expor mensagens
  internas do banco.

## Banco do Supremo

A consulta real confirmou ausência das migrations021–024, separadamente do banco
de chamados. As quatro migrations já incluídas no main foram aplicadas em uma
transação, com limite de espera por locks e preservação de RLS. Após aplicação:

- a API respondeu200 para colunas de secrets e restore antes ausentes (42703);
- função de ordenação021 e funções de restore022 presentes;
- oito índices023 e cinco colunas024 presentes;
- nenhum dado do app v4 foi alterado por esse rollout.

Nenhuma migration histórica foi reescrita. A confirmação de rollout não implica
que um secret real tenha sido entregue ou que o usuário já tenha restaurado um
checkpoint pela interface.

## Validação da correção

- 1.527 testes do motor; cobertura de linhas94,98%.
- 593 testes da CLI; inclui Git, processos, recuperação e preservação de preview.
- Typecheck do motor/CLI, lint e build de produção Webpack aprovados.
- Auditoria estrita: zeroCRITICAL/HIGH; permanecem13 avisosMEDIUM preexistentes.
- PostgreSQL local descartável: migrations001–024, concorrência de restore,
  lease/ACK, propriedade, revisão, RLS e proteção dos metadados de secrets.
- Replay isolado do v4: os três arquivos antes rejeitados foram executados e seus
  16 testes passaram. Depois disso, a validação identificou problemas reais de
  tipagem e testes herdados da interface inicial; não foram considerados aprovados.

## Ativação

Release de correção: template4.0.1, CLI1.7.1, baseline3.0.0 preservado.
Publicar o motor atualizado e atualizar a base gerenciada do projeto existente.
Preservar os arquivos do app, o índice/HEAD local, os dados e o processo de preview.
As versões antigas do checkpoint permanecem no histórico; uma recuperação cria
nova evidência e só publica depois de passar pelos gates. Falha anterior não é
apagada nem convertida artificialmente em sucesso.

O E2E hospedado de publicação/CI/integração, restore pela interface, entrega de
secret e cron ainda precisa ser observado após ativação da correção. Testes locais
ou uma interface funcionando não substituem essas evidências.
