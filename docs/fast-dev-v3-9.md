# Desenvolvimento rápido — template 3.9.0 / CLI 1.6.0

Esta entrega corrige os problemas observados na rodada manual da Central de
Chamados. A rodada original terminou com falhas; a regressão abaixo identifica
separadamente o que foi comprovado localmente e o que depende do rollout.

## Comportamento

O padrão é pedido → implementação → preview → avaliação do usuário. O agente
não executa testes, cobertura, build ou QA de navegador por rotina. O comando
`supremo turn validate` solicita uma validação completa em cópia isolada. A opção
explícita `.supremo/lifecycle.json: {"validation_mode":"background"}` habilita
testes locais automáticos. O padrão ausente/novo é `on_request`.

Falhas anteriores de tipos, lint, unidade, integração ou E2E continuam registradas
como pendências, sem bloquear um pedido comum ou seu checkpoint. Segurança, RLS,
migrations, autoridade do ambiente e concorrência mantêm seus bloqueios. Uma
nova edição não resolve uma falha por declaração; a evidência deve corresponder
à versão examinada. Aprovação remota da versão atual não apaga o histórico antigo.

O snapshot usa um índice Git separado e captura arquivos já versionados dentro
de `dist/` sem incluir arquivos privados ignorados. HEAD e staging são preservados.
O worker padrão verifica segredos diretamente nos blobs imutáveis, sem executar
scripts do app. Um resultado limpo fica `deferred`, aguardando a CI, e não `passed`.

## Checkpoints e integração

O daemon informa metadata limitada independentemente da publicação: ID, SHA,
revisão e estado. Não envia código, prompts, caminhos ou logs nesse canal. O
endpoint autentica dispositivo, dono, projeto e SHA. O histórico mostra envio
pendente ou falha local mesmo quando o último CI da estrutura inicial estava verde.
Offline, a fila e o registro permanecem locais e serão reenviados após reconexão.

A migration 020 aplica revisões monotônicas atomicamente. Um relatório atrasado
não rebaixa um checkpoint publicado/integrado e metadata local não passa a ser a
base de sincronização de código. Restore exige uma versão efetivamente publicada.
Ao entrar em publicação, a ordem do checkpoint recebe a hora do servidor uma
única vez; relógio local atrasado e retries não podem fazer a sincronização
ignorar a nova versão ou aceitar sua antecessora como base atual.
Registros legados sem ambiente/prova aguardam confirmação atual do projeto e
repositório, depois passam pela varredura antes do envio.

Os testes obrigatórios de GitHub, incluindo cobertura, E2E e isolamento, continuam
exigidos para integração, inclusive em projetos com a antiga opção de modo rápido.
Merge manual e gerenciado verificam todos os gates do HEAD atual e enviam o SHA
esperado ao GitHub. O modo nativo só é habilitado com os checks completos e proteção
de branch que os exija; proteção antiga insuficiente impede habilitar o automerge.

## Entrega a projetos existentes

1. Aplicar `supabase/migrations/020_checkpoint_local_reports.sql` e depois
   `supabase/migrations/021_checkpoint_publication_order.sql` no banco do
   **control plane Supremo**, mantendo as migrations anteriores. Não é migration
   do banco do app gerado. A 020 é necessária antes do deploy que consulta as
   colunas; a 021 mantém a ordem de publicação independente do relógio local.
2. Publicar a versão do Supremo com o bundle CLI 1.6.0 e template 3.9.0.
3. Usar a atualização de base do projeto. AGENTS/CLAUDE recebem apenas um bloco
   de política gerenciado; preferências e texto do usuário são preservados.
   `.supremo/DEVELOPMENT.md` acompanha a atualização. Revisões de hooks continuam
   sujeitas à confiança exigida pelo host.
4. Reinstalar a CLI local atualizada quando necessário e reiniciar **somente o
   daemon antigo**. Preservar o preview, porta, ambiente e trabalho local.
5. Conferir o checkpoint no histórico, a PR e os gates correspondentes ao mesmo
   SHA. O modo nativo recusa proteção antiga sem todos os checks; atualizar os
   checks obrigatórios preservando as outras restrições antes de reabilitá-lo.

Este checkout e sua suíte de testes não aplicam migrations, atualizam daemons de
outros projetos nem publicam produção silenciosamente. A instalação antiga da
Central de Chamados continua antiga até receber essa atualização.

## Evidências da regressão

- `scripts/test-fast-dev.mts`: template real, navegador real, Git e novos processos
  do sistema. Duas edições com falha anterior controlada produziram dois checkpoints
  e preservaram rascunho, PID e URL. Backend/modelo são fronteiras controladas.
  Medição local única: 363ms e 367ms até a mudança visual; exclui tempo de geração
  do modelo e não constitui promessa de latência para qualquer app.
- `scripts/test-checkpoint-report.mts`: PostgreSQL descartável real comprovou
  identidade, revogação, SHA, ordem, RLS, restore e corrida com publicação.
- `scripts/test-development-database-local.mts`: PostgreSQL real comprovou
  isolamento de leitura/escrita, retry/rollback de migrations e recusa em produção.
- A CLI 1.6.0 foi instalada por HTTP local e executada sem registry; os 439 testes
  da CLI passaram.
- Supremo: 1.123 testes em 77 arquivos passaram, com cobertura de 92,93% das linhas
  e 93,61% dos ramos. Typecheck, lint (zero erros; cinco avisos preexistentes),
  auditoria estrita e build de produção passaram.
- O template gerado passou por tipos, lint, testes/cobertura, auditoria e build.
  A validação completa do worker, solicitada explicitamente, também passou em
  cópia isolada com navegador real, preservando o checkout original.

No GitHub do app observado havia zero PRs e apenas a execução da estrutura inicial
`6bde3b315eefa2e38152458899b9947a4503e33e`. Isso comprova ausência de publicação das
alterações naquele momento; não comprova um automerge sem testes. O fluxo de merge
recebeu endurecimento adicional durante a revisão desta entrega.

O E2E com o modelo escolhido, Supabase/GitHub hospedados, aplicação real da nova
base e reinício físico do notebook continua sendo uma prova pós-rollout. A suíte
local não é apresentada como essa execução remota.
