# E2E real — Supremo 3.8.0 / CLI 1.5.0

## Contexto

- Projeto: central-de-chamados-e2e, criado pelo usuário.
- Agente de desenvolvimento: Codex, GPT-6 Astra Leve.
- Preview: http://localhost:3002, preservado durante a preparação.
- Primeiro pedido: Central de Chamados com login, CRUD, prioridades, status e dados privados por usuário.
- Fonte: observação do usuário, screenshots e inspeção somente de leitura do projeto/tarefa.

## Primeira entrega

- Duração exibida na tarefa: **14min26s**. O usuário considera excessiva e quer uma redução substancial sem perder arquitetura e segurança.
- Houve interrupção/reenvio do pedido; não tratar essa duração como benchmark limpo nem atribuir todo o tempo ao modelo, aos testes ou ao Supremo.
- Preflight encontrou recusa de escrita Git por permissões do host e conflito da regra `dist/` com `tools/supremo-cli/dist/bin.js`.
- O agente precisou corrigir o `.gitignore` do app antes de implementar a funcionalidade. A correção deve ser incorporada ao template/motor, com reprodução do problema.
- Foram observadas leituras repetidas após a interrupção. Medir separadamente retomada, leituras, geração de código, ferramentas e validações antes de escolher a correção de desempenho.
- O agente iniciou QA de criação/edição/exclusão, falhas, envio repetido e mobile após implementar a interface.
- O screenshot final mostra interface, contadores, busca, filtros e um chamado. Isso não comprova CRUD completo, persistência, isolamento entre contas, paginação ou gates remotos aprovados.
- A resposta final do agente informa que a prova automática de isolamento entre contas está pendente em background.

## Intervenção que afetou a medição

O observador enviou uma mensagem à tarefa de desenvolvimento para interromper QA autônomo e registrar uma preferência nas instruções locais. O usuário esclareceu que queria **anotações para corrigir o motor**, e não uma intervenção naquela conversa. A mensagem foi enviada e pode ter alterado o comportamento/regras do app; não foi desfeita nem foi confirmada aqui a alteração dos arquivos. Esta execução não é uma observação sem intervenção.

Daqui em diante, nesta avaliação, registrar achados sem enviar mensagens ou alterar o app/tarefa em teste, salvo solicitação explícita do usuário.

## Direção solicitada para o motor — ainda não implementada

- Fluxo desejado: usuário pede → agente implementa → preview disponível → usuário testa → agente corrige o feedback.
- O agente só inicia testes/QA quando o usuário pedir. Evitar testes, criação de contas de teste, builds de verificação e navegação exploratória por rotina no turno de implementação.
- Preservar validação de entradas no servidor, autenticação, autorização, RLS, migrations e arquitetura dos apps. Reduzir espera não significa remover proteções em runtime.
- Manter separado o trabalho do agente e a infraestrutura de validação em background; medir duplicação e bloqueios. Não declarar validação pendente como aprovada nem remover gates para melhorar a métrica.
- Medir tempo até a primeira tela útil e tempo até cada alteração visível, além do tempo total. Nenhuma meta numérica de latência foi acordada ainda.

## Próxima etapa manual

### Encerramento da rodada manual: retomada sem histórico

- Pedido em conversa nova: `Mostre a data e a hora de criação em cada chamado.`
- Duração final exibida: **2min55s**, sem aplicar a alteração. Os screenshots desta
  conversa mostram **Astra Ultra**, não Leve; não atribuir a duração ao mesmo perfil
  da primeira interação. Houve subagente de inspeção e leitura do bundle da CLI.
- O agente identificou que o horário já existia, mas entrou em recuperação de
  testes anteriores e terminou pedindo autorização para corrigir seletores/testar.
- Inspeção do app confirmou `created_at` no tipo `Ticket` e consulta `select('*')`
  em `app/app/page.tsx`. Exibir esse campo não exigia nova consulta de diagnóstico
  ao Supabase nem migration. Fuso e apresentação são decisões da interface.
- A regra de testes sob demanda adicionada na intervenção anterior conflitou com
  o recovery obrigatório do motor. A correção precisa remover essa contradição no
  fluxo gerado e no protocolo executável, não apenas aconselhar outro prompt.
- O usuário encerrou a rodada manual e autorizou corrigir o motor e validar as
  correções. A partir deste ponto, os testes de engenharia são autorizados para
  essa entrega; isso não muda o padrão solicitado para agentes de apps gerados.
- Esta rodada manual terminou com falhas. Reinício do notebook, CRUD completo,
  isolamento real entre duas contas e preservação de formulário não foram
  comprovados nesta sessão. Resultados posteriores de regressão devem identificar
  separadamente fixtures locais, navegador real e serviços remotos.

### Segunda interação: mudança cosmética

- Pedido: alterar apenas os botões principais para verde-esmeralda, preservando interface e rascunhos.
- Screenshot mostra duração total da tarefa de **40 segundos** e botão `Novo chamado` verde no mesmo endereço `localhost:3002/app`. Tempo exato até a primeira atualização visual não foi medido.
- O agente relata alteração por CSS sem recarregar a página nem alterar formulários. O screenshot não demonstra preservação de rascunho, PID ou ausência de reload; esses itens permanecem sem comprovação independente.
- O agente também relata: registro de conclusão bloqueado pela revisão automática devido a falhas anteriores pendentes. Trata-se de relato visível, ainda sem inspeção do erro para distinguir política de aprovação do host, recovery do Supremo ou outra origem.
- Novo atrito: alteração visível no preview, mas conclusão/checkpoint não confirmado. Na correção do motor, separar registro de trabalho, estado de validação e autorização de integração; preservar diagnóstico e bloqueios de publicação sem tornar o trabalho invisível.
- Próxima prova sugerida: retomada em conversa nova na mesma pasta, pedindo somente data/hora de criação. Observar se reconhece a implementação e a pendência, preserva preview e explica eventual bloqueio. Não exigir testes autônomos nesta avaliação, conforme preferência do usuário. Recuperação automática completa permanece uma prova separada e ainda não concluída.

### Achado adicional: checkpoint invisível no painel

- Após a primeira entrega, o usuário mostrou o painel com `READY`, `Tudo verde` e `Nenhuma mudança ainda`.
- Inspeção somente de leitura confirmou um checkpoint local: `1cacbb25-f48c-4691-9e2c-5f9360a20c99`, capturado no evento `complete` em `2026-09-07T00:34:46.215Z`.
- A fila é um histórico de atualizações do mesmo checkpoint: passou por `pending`, `running` e `failed`. Estado observado mais recente: `pushStatus=local`, `validationStatus=failed`, zero tentativas de publicação.
- Relatório vinculado `2b43a7a0-3e83-4f22-bd53-f3dc332021fc`: typecheck e browser E2E falharam; lint, unit/integração e secret scan passaram. As causas específicas das falhas ainda não foram diagnosticadas; não inferir que representam necessariamente defeitos funcionais do app.
- Portanto o checkpoint foi criado, mas não foi publicado após a falha local. O painel não apresenta esse trabalho nem seu bloqueio e o rótulo verde não reflete a validação local atual.
- Correção desejada no motor: distinguir captura/sincronização do registro e aprovação/publicação do código; mostrar checkpoint pendente ou bloqueado com diagnóstico no painel, sem exigir sucesso dos gates para dar visibilidade e sem liberar código reprovado como aprovado.
- Nenhum comando de checkpoint, publicação, teste ou mensagem ao agente foi executado nesta inspeção.
- Screenshot seguinte do GitHub Actions mostra apenas uma execução, `feat: estrutura inicial do projeto`, commit `6bde3b3`, branch `main`, aprovada em 7min03s. Não há execução visível das alterações da Central de Chamados nesse momento. É consistente com o checkpoint local reprovado e ainda não publicado; o verde inicial não comprova a versão do preview.
- Registrar a cadeia completa do atrito: falha na validação local → publicação não realizada → nenhuma nova execução remota → painel continua exibindo o verde da estrutura inicial. A correção deve tornar cada etapa e a versão correspondente visíveis, sem apresentar a ausência de validação remota como aprovação.

1. No app atual, criar um chamado, editar título/status, atualizar a página para confirmar persistência e excluir apenas esse registro descartável.
2. Se funcionar, pedir uma alteração visual pequena na mesma conversa, mantendo um formulário com rascunho aberto: mudar somente a cor dos botões principais para verde-esmeralda, preservando o rascunho.
3. Registrar tempo até a mudança aparecer, URL, preservação do rascunho e qualquer espera por QA/build/CI. O teste pequeno separa custo de iteração do custo da criação inicial.
4. Depois, avaliar evolução funcional, duas contas e retomada/recuperação. Não declarar E2E completo antes dessas provas.
