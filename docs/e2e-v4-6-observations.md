# E2E v4-6 — observações

## 2026-09-13 — recuperação automática de pendência local não demonstrada

Projeto: `87a4498d-6072-4098-864f-fc350a984b45` (v4-6).

**Falha de experiência confirmada pelo usuário:** o motor registrou falhas de
verificação de tipos nos dois primeiros checkpoints, mas a correção só ocorreu
depois que o usuário pediu ao agente para investigar e corrigir. A alteração
visual seguinte manteve a pendência anterior. O fluxo automático esperado não
foi cumprido; recuperação por pedido não conta como recuperação automática.

Evidências fornecidas pelo usuário: histórico com duas pendências locais;
resposta do agente informando correção de tipos no painel e sincronização no
teste de login, 41 testes aprovados em ambiente isolado e novo checkpoint;
posteriormente, PR #1 do repositório Hijaziia/v4-6 com verificações na fila.
Essas evidências não estabelecem a causa interna da ausência de recuperação.

**Requisito reiterado pelo usuário:** prompt → implementação → preview → controle
devolvido. O motor deve detectar a falha, acionar a correção, validar novamente
e continuar a publicação em segundo plano, sem exigir outro pedido do usuário.
Preservar dados, segurança, alterações em andamento e preview saudável.

**Critério de aceite pendente:** provocar uma falha local corrigível em projeto
de teste e comprovar, sem novo prompt, a sequência de detecção, correção,
revalidação, checkpoint corrigido e avanço ao GitHub. Registrar evidências por
versão e impedir publicação enquanto houver reprovação. Uma falha que exija
intervenção externa deve ter motivo explícito; não pode ficar silenciosamente
pendente nem ser marcada como resolvida sem validação.

Status inicial: registrado para investigação. Diagnóstico e correção abaixo.

## Integração após aprovação — observação inicial

O usuário mostrou o PR #1 de `Hijaziia/v4-6` ainda aberto, com sete
verificações aprovadas, sem conflitos e indicado como pronto para integração.
O Supremo mostrava “Testes aprovados” e “Aguardando integração”. Portanto,
envio ao GitHub e verificações avançaram, mas a integração automática não foi
demonstrada. A idade do PR no print não mede o tempo desde a aprovação.

Investigar configuração de integração, processamento dos eventos e eventual
motivo de bloqueio antes de atribuir causa. Não integrar manualmente para
simular sucesso do fluxo automático. Critério de aceite: integração pelo motor
após cumprir suas regras e atualização do histórico sem intervenção do usuário.
O resultado da investigação está registrado abaixo.

## Diagnóstico e correções — 2026-09-13

### Recuperação local

Os arquivos locais mostraram que a autocura foi iniciada. O problema não era
ausência de acionamento: abrir um novo turno cancelava a proposta isolada mesmo
antes de qualquer edição. Às 00:19:47 de Porto Velho, o pedido de botões azuis
iniciou um turno; a proposta foi cancelada às 00:19:50, antes da edição registrada
às 00:20:06. A interrupção consumia tentativa e podia esgotar o reparo.
O histórico anterior sobrescrevia o diagnóstico de cada tentativa; não permite
concluir a causa da primeira tentativa individual.

A correção no motor mantém proposta e validação em cópias isoladas durante um
turno ativo. Aplicar a correção continua exigindo que o turno termine e que
código, HEAD, índice, autorização e regras permaneçam compatíveis. Um candidato
válido fica preservado para retomada, inclusive após pausa ou contenção do lock,
e é novamente validado sem outra chamada ao modelo. Edições novas substituem o
candidato antigo. Execuções interrompidas têm limite próprio, herdado pela cadeia
de reparos, e o histórico sanitizado preserva os motivos das transições.

Um ensaio do motor com uma chamada real ao Codex e TypeScript strict levou
14,3 segundos: falha original, correção isolada, validação aprovada, espera pelo
turno ativo, revalidação e aplicação automática com novo checkpoint pendente.
HEAD e índice foram preservados. O ensaio usou uma fixture temporária com
autorização simulada de desenvolvimento; não comprova o backend remoto nem
uma nova publicação completa pelo v4-6.

### Integração após testes aprovados

A GitHub App `supremo-platform` não possuía `Actions: read`. O controlador já
usava o endpoint de merge com o SHA validado; falhava antes disso ao consultar
a execução confiável de `ci.yml`, que retornava 403. Ter `Workflows: write`
não supria essa leitura.

Com autorização específica do usuário, foi adicionada somente `Actions: read`
à App e aceita a atualização na instalação Hijaziia. Sem chamada manual de
merge ou reconciliação, o próprio bot integrou
[PR #1 de Hijaziia/v4-6](https://github.com/Hijaziia/v4-6/pull/1)
às **01:05:58 de Porto Velho**. SHA validado:
`bab3924fa3e4d49c381248af3b2fa61864bc5820`; merge:
`41464f4cbe900e3c328d0de325fa321b4a2891f4`.

Na leitura das 01:06:30, o projeto estava `merged`, o checkpoint
`01ab70f2-c04f-4a04-bd5f-67609086f784` estava `integrated` e o Supremo informava
“Versão validada e integrada.” Os sete checks estavam aprovados.

O código também passa a persistir o motivo de bloqueio da leitura do workflow,
mantendo a aprovação dos testes como fato separado da integração. A próxima
tentativa continua automática. Gates, políticas e conferência do SHA foram
preservados; nenhuma integração forçada foi usada.

### Verificação e limites

- Supremo: 1.670 testes aprovados, cobertura de linhas 96,16%.
- CLI: 615 testes aprovados, incluindo 12 regressões novas do ciclo de reparo.
- Tipos, lint, auditoria estrita e build de produção aprovados. A auditoria
  registrou 13 achados médios preexistentes, sem críticos ou altos.
- App, dados, interface e preview do v4-6 não foram alterados por estas correções.
- A integração foi comprovada no projeto real. A recuperação local corrigida
  foi comprovada no ensaio descrito e ainda precisa ser distribuída na nova CLI.
- Restore e os demais recursos fora destas duas pendências não foram novamente
  testados nesta etapa; este registro não representa aprovação de todo o E2E.

### Distribuição preparada

A correção acompanha CLI **1.7.4** e template **4.0.5**. A autoridade das versões
anteriores é preservada para continuar validando projetos já criados.
Por orientação posterior do usuário, nenhum projeto antigo será atualizado
nesta etapa. A validação completa seguinte será em um projeto novo, gerado
depois da publicação do motor. Publicar o motor não atualiza automaticamente
um bundle já instalado na máquina.
