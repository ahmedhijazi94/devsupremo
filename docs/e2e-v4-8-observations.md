# E2E — correções do motor

## Escopo autorizado

Corrigir somente os três pontos encontrados no E2E: nomes das versões, coerência
dos estados/diagnósticos e administração do Supabase pelo agente. A implementação
e a publicação são no motor. Projetos anteriores servem somente como evidência
histórica; não serão alterados ou usados para executar operações administrativas.
O exemplo de desativar confirmação de email é requisito de capacidade, não pedido
para alterar essa configuração em um projeto existente.

## Evidências fornecidas pelo usuário

- Funcionamento do app, login e despesas confirmado pelo usuário.
- Mudança visual preservou o conteúdo do formulário aberto.
- Após falha de E2E, um pedido comum levou o agente a corrigir o problema anterior.
  A revisão passou e foi integrada pelo Supremo.
- Mudanças posteriores, restauração com salvaguarda e novos pedidos após restaurar
  também chegaram à integração, com testes finais aprovados.
- Consulta sem alterações retornou despesas, mas não contou usuários porque o
  acesso disponível bloqueava `auth.users`.
- Nomes genéricos e mensagens antigas dificultavam interpretar o histórico.
  O agente continuava mencionando uma validação móvel já resolvida.

## Correções incluídas — CLI 1.7.7 / scaffold 4.0.8

1. **Nomes reconhecíveis.** O encerramento aceita `--summary` e as regras geradas
   orientam o agente a descrever a alteração efetiva. Na ausência de descrição,
   os arquivos alterados fornecem um título factual. Não rebatizar versões antigas
   sem evidência nem alterar os pontos de restauração.
2. **Estado e diagnóstico coerentes.** O resumo distingue integração com testes
   finais em andamento, aprovados ou com falha. Checkpoints intermediários
   incluídos na integração deixam de mostrar mensagens antigas como pendência
   atual; o texto não afirma que cada snapshot intermediário passou individualmente.
   O contexto do agente encerra a pendência anterior somente com sucesso atual
   associado ao projeto, ambiente, revisão e sequência de checkpoints, cobrindo
   os testes que falharam. A evidência histórica continua armazenada.
3. **Administração de autenticação.** Comandos `auth count/users/config` consultam
   usuários e configuração; `auth configure/create/update/delete` executam as
   operações administrativas suportadas. Mutações exigem ambiente explícito.
   Dono, dispositivo, conta e vínculo são revalidados no servidor antes das chamadas.
   As credenciais administrativas não são entregues ao agente nem ao app.
   A configuração alterada é consultada novamente antes de confirmar sucesso.

## Validação da correção

- Testes de títulos, execução com hooks, leitura sem checkpoint e recuperação
  com sucesso posterior, incluindo recusa de evidência antiga, de outro projeto,
  sem relação entre versões ou com testes insuficientes.
- Testes da administração pela rota, serviço e CLI: contagem, projeção de usuários,
  alteração de configuração, ambiente explícito, revogação durante a operação,
  mudança de conta/projeto e ausência de credenciais nas respostas.
- Compatibilidade da política 4.0.7 preservada com fixture gerada a partir da
  revisão original, além da política 4.0.8.
- Suítes completas do motor e da CLI, cobertura, tipos, lint, auditoria estrita,
  compilação de produção e instalação do pacote distribuído.

As chamadas externas de administração foram verificadas com respostas controladas
nos testes. Nenhum usuário, despesa ou ajuste de autenticação de projetos anteriores
foi alterado para validar esta entrega. Um próximo E2E pode exercitar as operações
reais em um novo projeto descartável.
