# E2E v3-22 — retomada, navegador e revisão

Revisão local em 05/09/2026. Correção no gerador do Supremo, template 3.6.2.
A pasta `/Users/ahmedhijazi/dev/v3.22/v3-22` foi usada como evidência, sem alteração.

## Diagnóstico e correções

As capturas mostram preview recusando conexão e o agente alegando que todas as
portas de 3000 a 3019 estavam ocupadas. Não há trace do comando original para
provar qual errno ocorreu naquela sessão. No ambiente restrito desta revisão,
um bind local simples retorna EPERM. O código antigo tratava qualquer erro
indeterminado como ocupação e o preflight descartava stderr: o falso diagnóstico
foi reproduzido em testes com EPERM/EACCES/EIO.

- Apenas EADDRINUSE significa porta ocupada. Erros indeterminados interrompem
  o probe com o código original, sem assumir porta livre nem varrer outras portas.
- O preflight preserva erro e ação de recuperação no JSON. Restrição de bind
  não ganha um retry inútil no mesmo contexto. Colisões transitórias ainda têm retry.
- AGENTS e CLAUDE orientam repetir a retomada pelo mecanismo oficial de execução
  e permissões do host, continuar o pedido quando saudável e respeitar recusas.
  O script não concede permissões nem contorna o isolamento do agente.
- Preview que não fica pronto retorna falha, preservando o estado anterior.
- AGENTS, CLAUDE e DESIGN exigem pedido explícito para QA manual no navegador,
  inclusive em bugs, primeira tela e alterações de layout. Abrir o painel para
  o usuário e executar a suíte E2E automatizada continuam permitidos.
- Heartbeat e token de instância entram no gitignore do scaffold. Na pasta E2E
  esses arquivos locais estavam versionados; parar o preview gerava exclusões no Git.

## Revisão de segurança e escala

Foram revisados o ciclo de retomada/checkpoints, geração de regras, trilhos de
atualização, autorização de banco e ações, migrations e testes do E2E anexado.
A suíte completa amplia a verificação de regressões; isto não é uma auditoria
externa, teste de carga ou demonstração de todas as integrações em produção.

Pontos sustentados pelo código e pelos testes: checagem de dono nas operações
privilegiadas examinadas, dispositivo autenticado, banco development revalidado
antes de cada migration, isolamento via RLS, transações/histórico de migrations,
retries idempotentes e testes negativos de acesso. A auditoria estática estrita
não encontrou achados nos padrões que verifica.

Limitações concretas para chamar a plataforma ou seus apps de “100%”:

1. `src/proxy.ts` usa um Map por processo para rate limiting; não coordena cotas
   entre instâncias, não limpa todas as entradas expiradas e limita auth/API,
   sem aplicar a mesma política a todas as rotas protegidas/Server Actions.
   O proxy gerado não implementa um limitador geral de requisições da aplicação.
   Há proteção dos provedores, mas isso não equivale a cotas por usuário/tenant.
2. A migration `suggestions` do E2E tem RLS, dono, constraints e índice de user_id.
   Porém, `supabase/rls.rls.test.ts` cobre profiles e audit_logs, não suggestions.
   Não há prova de isolamento cruzado daquela nova tabela nessa suíte. A regra
   já exige testes por tabela; a auditoria estática não garante que foram escritos.
3. Regras de paginação, índices e jobs existem no documento de arquitetura,
   mas não certificam queries e fluxos futuros. Escala exige metas de carga,
   teste representativo e observabilidade de cada app.
4. Não foram executados acesso remoto com duas contas, migrations reais, deploy,
   nem o fechamento/reabertura da interface do agente. Os testes automatizados
   exercitam reinício de processos e repetição no contexto permitido.

## Distribuição

Mudanças preparadas no checkout do Supremo; nenhum deploy ou atualização do app
E2E foi realizado. Novos apps recebem o template 3.6.2 quando esta versão do
Supremo for disponibilizada. Apps existentes não recebem regras novas só por
atualizar o backend: o sincronizador preserva documentos editáveis e atualmente
não trata preview.mjs/supremo-status.mjs como arquivos gerenciados. Uma atualização
existente precisa preservar as decisões do app e aplicar explicitamente esses
scripts e regras. Não apresentar o v3-22 antigo como já corrigido.

## Validação realizada

- Supremo: 914 testes aprovados em 57 arquivos; cobertura 91,43% de linhas e
  statements, 93,24% de branches e 94,09% de funções (thresholds de 85%).
- CLI: 204 testes aprovados em 14 arquivos.
- Regressão executável: EPERM/EACCES/EIO preservados no JSON, apenas um probe,
  nenhum PID de candidato salvo e sem alegação de portas ocupadas. Em EPERM,
  nova invocação no contexto permitido recupera preview e daemon saudáveis.
- Demais cenários de retomada, heartbeat, IPv4/IPv6 e colisão de portas aprovados.
- Typecheck sem erros; lint sem erros, com cinco avisos preexistentes.
- Auditoria de segurança estrita: zero achados; RLS detectado nas 19 tabelas.
- Build de produção com Webpack aprovado. `npm run build` com Turbopack falhou
  ao abrir uma porta interna (Operation not permitted), mesmo solicitando
  execução com permissões ampliadas; não foi classificado como build aprovado.
- Nenhuma interação manual de navegador foi usada nesta tarefa.
