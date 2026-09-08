# Auditoria do motor — fluxo profissional antes do E2E

Registro da auditoria inicial, anterior à implementação do template 4.0. As
correções e evidências posteriores estão em [Motor profissional](motor-profissional.md).

## Conclusão

É possível implementar o fluxo desejado na arquitetura atual, mas a revisão
`4c675646160e5db0f7ced2c75d4da336c3b9afa5` (PR #57, mesclado) ainda não o entrega
integralmente. **Aprovado como direção arquitetural; reprovado como garantia atual
de automação independente do agente.** Há defeitos de restore, concorrência e
integridade dos validadores que devem ser corrigidos antes da rodada final.

Esta rodada é uma auditoria: examinou o código e executou reproduções descartáveis.
Não modificou o motor, o app da Central de Chamados nem serviços externos.
Os checks verdes dos PRs #56/#57 comprovam que os testes existentes passaram;
não comprovam os casos ausentes que esta auditoria encontrou.

## Contrato do produto confirmado pelo usuário

**Prompt → agente implementa → preview atualiza → controle devolvido ao usuário.**

O motor executa testes locais automáticos adaptativos, checkpoints, publicação,
CI e autocorreção em background. A nova preferência substitui o padrão anterior
de testes locais somente sob demanda. Trabalho comum não espera CI, cobertura,
build ou browser QA. Bloquear uma promoção insegura é diferente de bloquear uma
edição local que pode corrigi-la.

O agente deve receber contexto e regras verificáveis, trabalhar dentro dessas
regras e entregar a alteração. Ele não pode ser a única fonte de aprovação,
nem ter liberdade irrestrita para enfraquecer seus validadores. O motor precisa
mostrar estado real e permitir pausar/cancelar jobs e restaurar código.

## O que já existe

- Supervisor de preview persistente, preservação de porta/processo e HMR.
- Protocolo executável de turnos, snapshots Git, fila persistida e vínculo de
  evidências com projeto, ambiente, checkpoint e SHA.
- Worker local que executa verificações em uma worktree separada, sem copiar
  credenciais do app; isso isola saídas de build, **não é sandbox de scripts**.
- Controles de dono/dispositivo/projeto, ambiente de desenvolvimento e segredos.
- Políticas RLS e provas de isolamento; conjunto obrigatório de nomes de checks
  antes do merge e comparação com o SHA atual.
- Restore que cria uma nova versão e preserva migrations; o fluxo de confirmação
  e retomada, porém, contém os defeitos descritos abaixo.

## Achados prioritários

### P1 — O código avaliado pode alterar seus próprios validadores

`src/lib/checkpoint/grant.ts:39` concede `workflows:write` quando o checkpoint
modifica o workflow. Scripts de testes, configurações e comandos do `package.json`
também permanecem editáveis. `src/lib/github/merge-policy.ts:118` exige
nome/status/sucesso, sem comprovar a integridade da definição que produziu o check.

Consequência: manter nomes dos jobs e substituir sua execução por comandos vazios
pode produzir checks reais verdes sem a validação pretendida. A lista de arquivos
gerenciados orienta atualização/restore; não é uma barreira de autorização.

Correção: separar alterações de produto de atualizações autorizadas da base;
verificar a versão/integridade dos validadores no servidor e executar a aprovação
em definição confiável. Incluir comandos, configuração, regras e fontes dos
validadores nessa fronteira, não apenas o YAML do GitHub.

### P1 — Check verde pode significar teste não executado

`src/lib/templates/project-files.ts:2402` e `:2550` geram jobs de RLS/E2E que
terminam verdes com uma mensagem quando o filtro considera a área inalterada.
O filtro E2E (`:2333`) não inclui sequer `e2e/**` ou o workflow. Mudar somente
um teste E2E pode, portanto, não executar Playwright.

Correção para o contrato pedido: validação completa obrigatória no GitHub;
adaptatividade fica no worker local. Qualquer reaproveitamento futuro precisa
comprovar equivalência das dependências e da versão dos validadores.

### P1 — Falso negativo no auditor de autorização

`scripts/security-audit.js:448` remove literais com `stripNoise`; `:453` passa
o resultado a `supabaseChains`, cujo padrão em `:391` exige o nome literal da
tabela. Uma cadeia `.from('tickets').delete().eq('id', id)` deixa de ser detectada.
Além disso, a coleta em `:126` omite `components/` na raiz e um marcador de
autenticação em qualquer parte do arquivo é aceito para outras funções (`:345`).

Correção: análise que preserve a estrutura relevante, preferencialmente AST,
cobertura de todos os diretórios e autorização por operação. Provas de servidor
e de isolamento continuam necessárias; um marcador textual não prova autorização.

### P1 — Restore pode confirmar sucesso sem persistir o resultado

`packages/cli/src/daemon.ts:627` cria o checkpoint resultante localmente e reporta
o restore antes de garantir a existência desse checkpoint no backend. A referência
remota possui foreign key. `src/lib/checkpoint/store.ts:444` ignora o erro devolvido
pelo Supabase, e `src/app/api/checkpoint/restore-report/route.ts:70` retorna sucesso.

**Reproduzido:** erro PostgreSQL `23503` na fronteira do adapter; a função real
resolveu como sucesso. O pedido pode permanecer em `claimed`. Também faltam lease,
expiração e retomada segura quando o daemon cai após reivindicar o pedido.

Correção: operação idempotente, identidade do checkpoint persistida antes da
confirmação, tratamento explícito de erros e fila durável de confirmação; lease
com dono e recuperação após interrupção. Restore de código não reverte dados do banco.

### P1 — Limpeza antiga pode apagar a branch de um checkpoint novo

`src/lib/github/reconcile.ts:158` relê uma PR antiga mesclada e apaga sua branch
em `:181`, sem verificar se ela avançou ou serve a outra PR.

**Reproduzido:** a função real processou uma PR mesclada no SHA A e apagou a ref
já no SHA B de outra PR. O modelo de GitHub usado foi local; nenhum repositório
externo foi alterado.

Correção: eliminar o reuso inseguro de refs ou controlar geração/posse da branch;
comparação e exclusão devem ser seguras contra avanço concorrente. Uma releitura
isolada seguida de DELETE sem condição ainda deixa uma janela de corrida.

### P1 — Falta executor independente de autocorreção

`packages/cli/src/turn-model.ts:327` muda estado e conta tentativas;
`turn-runtime.ts:218` entrega instruções ao agente no próximo preflight. O daemon
executa validações e sincronização, mas não inicia um agente reparador nem aplica
correções sozinho. Portanto, **estado de recovery não equivale a auto-heal autônomo**.

Correção: fila de reparos e executor configurado, com trabalho isolado, escopo
limitado, orçamento/timeout/tentativas, pausa e cancelamento. Só incorporar a
correção quando o workspace estiver disponível e ainda corresponder à base
analisada; revalidar, preservar testes/regras e nunca reparar produção por rotina.

## Outros bloqueios de qualidade e experiência

| Área | Evidência e consequência | Correção necessária |
| --- | --- | --- |
| Default local | `turn-validation.ts:51` continua `on_request`. | Política única de background adaptativo, refletida no runtime e nos templates. |
| Adaptatividade | `harness.ts:872` promove qualquer TS/TSX após o turno a cobertura completa; `:877` inicia browser para qualquer mudança em app/components. | Plano por risco/dependências, testes relacionados, cache de provas válido e orçamento de execução. |
| Fila | `turn-validation.ts:268` usa FIFO, sem cancelamento de jobs superados; drafts aguardam checkpoints. | Prioridade da versão atual, deduplicação, cancelamento seguro e limites de concorrência. |
| Preview quebrado | `turn-runtime.ts:233` exige preview saudável para autorizar edição. **Reproduzido:** desenvolvimento autorizado e daemon ativo, mas preview indisponível bloqueou a edição que poderia corrigi-lo. | Separar saúde do serviço da autorização de editar; manter autoridade do ambiente e proteção de dados. |
| Garantia do host | `turn-runtime.ts:229` declara `enforced` apenas com host/evento. **Reproduzido:** adapters informavam `assisted`, sem recibos, e runtime informava `enforced`. | Uma única avaliação de instalação, confiança e execução efetiva dos hooks, com estado honesto. |
| Feedback perdido | `api/github/reconcile/route.ts:53` seleciona estado do projeto e busca somente PR aberta em `activeBranch`. Publicação de checkpoints não mantém necessariamente esse caminho. | Reconciliar pelos checkpoints e números de PR persistidos, incluindo PRs fechadas/mescladas e webhooks perdidos. |
| Provas da funcionalidade | Critérios de aceite são opcionais; smoke do template cobre estrutura/login e não CRUD autenticado. | Gerar/manter provas comportamentais pertinentes em background e exigir isolamento quando houver dados privados. |
| Arquitetura | ESLint usa regras padrão; índices, paginação e separação de negócio são em grande parte instruções. Cobertura exclui componentes e páginas que podem acumular lógica. | Regras de fronteiras/imports, validação de entradas e invariantes SQL; medir desempenho/carga para demonstrar escala. |
| Atualização da base | `managed-paths.ts` não inclui todos os helpers RLS que precisam receber correções. | Atualizar infraestrutura gerenciada sem substituir testes/fixtures e funcionalidades do usuário. |

## Integração com o host

Hooks de início, ferramenta e fim de turno existem no Codex. Hooks locais precisam
de confiança na definição atual; mudanças podem exigir nova revisão. Hooks em
background não iniciam um novo turno quando o agente está parado e não podem
impor decisões síncronas. Por isso, apenas adicionar um hook assíncrono não
implementa autocorreção autônoma. Fonte: [documentação oficial de hooks](https://learn.chatgpt.com/docs/hooks).

O caminho curto deve fazer somente identificação/contexto mínimo, autorização
necessária e registro durável de eventos. Testes e reparos ficam em processos
separados. Quando o host não fornecer integração comprovada, o produto deve
mostrar modo assistido; não prometer controle que não possui.

## Evidências desta auditoria

- Reproduções do core: `/tmp/supremo-audit-core-probes.ts` e
  `/tmp/supremo-audit-core-probes-result.json`. Git, CLI, adapters e runtime reais;
  backend/saúde controlados. Confirmaram garantia divergente e bloqueio por preview.
- Reproduções de restore/cleanup: `/tmp/supremo-checkpoint-audit-repro.mts` e
  `/tmp/supremo-checkpoint-audit-repro.json`. Funções reais, fronteiras de banco/GitHub
  controladas localmente; confirmaram falso sucesso e exclusão da ref avançada.
- Auditor de autorização: `/tmp/supremo-audit-idor-probe.cjs` e `.json` extraem
  as funções reais, registrando hash e posição. Confirmaram uma cadeia original
  e nenhuma cadeia após a transformação usada pelo auditor.
- Fronteira dos gates: `/tmp/supremo-audit-gate-probe.cjs` e `.json` executam os
  módulos puros atuais; confirmaram a permissão de alterar workflow e decisão
  baseada nos checks sem integridade da definição. Não simulam nem alegam um
  merge indevido real em GitHub.
- A suíte anteriormente executada tinha 1.123 testes do Supremo e 439 da CLI
  aprovados. Esta auditoria não repetiu essa suíte como se comprovasse os casos
  novos: expôs lacunas que ela não cobria. Nenhum E2E de produto foi iniciado.

## Ordem recomendada antes do E2E final

1. Fechar integridade dos validadores, falsos negativos do auditor e CI completo.
2. Corrigir restore, concorrência de publicação/cleanup e recuperação de feedback.
3. Implementar o agendamento adaptativo, sem esperar testes para devolver controle.
4. Acrescentar o executor real de autocorreção e seus limites/conflitos/pausa.
5. Impor invariantes arquiteturais verificáveis e comprovar integração com o host.
6. Só então repetir o E2E com prompts normais, nova conversa, falhas controladas,
   reinício do daemon, dois usuários, restore e publicação protegida.

Critério de aprovação: mostrar a alteração e devolver controle antes da conclusão
dos jobs; comprovar quais checks rodaram e para qual versão; impedir alteração
indevida das regras; restaurar e retomar após falhas; reparar em isolamento sem
sobrescrever trabalho novo; bloquear promoção sem evidência válida. Melhorar em
relação a outro produto deve ser medido por esses resultados, não declarado.
