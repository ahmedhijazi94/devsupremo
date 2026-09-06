# Diagnóstico do ciclo de desenvolvimento — v3-24

Análise em 2026-09-05. Nenhuma alteração aplicada ao código do v3-24, ao
preview, ao banco ou à produção. Este documento registra achados e a proposta
de correção; não declara as melhorias implementadas.

## Evidência reproduzida

Foram exportados dois commits do repositório local para diretórios temporários,
reutilizando as dependências instaladas. Não foi usado o diretório de build do
preview. A reprodução local não substitui os logs históricos do GitHub: a
sessão não tinha acesso autenticado a eles. Não se atribui toda falha remota
aos problemas locais abaixo.

| Estado | Resultado dos testes | Cobertura de funções | Resultado do gate |
| --- | --- | --- | --- |
| `0aca2a0` — Evolui landing Atlas com recursos e interações | 11 passaram | 66,66% | Reprovado; mínimo 80% |
| `8e61da7` — correções de segurança, último commit local | 21 passaram | 70% | Reprovado; mínimo 80% |

No último commit, typecheck passou; lint terminou sem erros, com um aviso de
import não utilizado; auditoria estática estrita terminou com zero achados.
Na cobertura atual, `app/page.tsx` não foi exercitado e há funções da home
sem execução. O teste da home substitui `useActionState` por estado ocioso e
verifica a presença do formulário; isso não prova envio, sucesso ou erro.

Não foram executados build, Playwright ou testes contra Postgres neste
diagnóstico. Portanto não há comprovação de que esses gates estejam verdes.
O termo E2E do usuário descreve sua experiência completa; os cartões
“Falhou” não identificam especificamente uma falha de Playwright.

## Causas no Supremo

### 1. O retorno das falhas ao agente foi prometido, mas não conectado

`src/lib/templates/project-files.ts` gera a regra “no próximo pedido você
recebe um resumo barato”. Porém:

- `packages/cli/src/daemon.ts` publica checkpoints e processa restaurações;
  depois da publicação não acompanha os gates para alimentar contexto local.
- `src/lib/templates/harness.ts`, em `supremoStatusScript`, retorna preview,
  daemon e quantidade de checkpoints pendentes. Não retorna diagnóstico de CI.
- `getFailedJobLogs`, em `src/lib/github/client.ts`, está ligado ao painel por
  `src/actions/checks.ts`; não há entrega equivalente ao preflight do agente.

A infraestrutura sabe exibir o vermelho, mas o próximo pedido não recebe
automaticamente o erro necessário para corrigi-lo. Repetir a regra em Markdown
não completa esse fluxo.

### 2. O sucesso local não representa o gate de cobertura

O verificador gerado em `src/lib/templates/harness.ts` usa testes afetados no
modo rápido e testes unitários sem cobertura no modo de segurança. A CI exige
`test:coverage`. A regra escrita manda executar cobertura ao mudar lógica, mas
a ferramenta não faz essa escolha automaticamente. A reprodução demonstra
que todos os testes podem passar e a integração continuar bloqueada.

### 3. A configuração de cobertura também deixa lógica fora da medição

O template inclui `lib/**/*.ts` e `app/**/*.tsx`. Isso não abrange
`app/comments/actions.ts`, por exemplo. Além disso, exclusões amplas como
`app/login/**` podem excluir lógica de decisão junto de adaptadores.
Corrigir isso deve aumentar a confiança, preservando o threshold; não basta
excluir páginas ou diminuir o mínimo para apagar o vermelho.

### 4. O histórico confunde resultado do conjunto com falha individual

`reconcileCheckpointsForPr`, em `src/lib/checkpoint/store.ts`, aplica o estado
da PR a todos os seus checkpoints publicados. A fila local confirma que as
mudanças após a primeira landing foram publicadas na PR #2. Assim uma falha
do conjunto aparece repetida como “Falhou” em vários pedidos. Isso não prova
que cada pedido introduziu um defeito independente.

É necessário distinguir código salvo, publicação, validação da versão e
integração. “READY” junto de “Gate vermelho” também não explica qual desses
estados está pronto.

## Correção proposta, em ordem

1. **Entregar diagnóstico persistente.** No servidor, registrar resultado por
   projeto, checkpoint, SHA publicado e execução/tentativa do CI. Incluir gate,
   etapa, trecho limitado e sanitizado do erro, horário e link de evidência.
   Reutilizar a autorização por dispositivo/dono/escopo; nenhum token GitHub
   deve chegar ao contexto do agente.
2. **Transportar em background.** O daemon consulta esse resultado com timeout,
   backoff e tratamento de indisponibilidade e grava um arquivo local de forma
   atômica. O preflight lê esse arquivo sem aguardar CI nem acessar GitHub.
   Diagnóstico ausente ou antigo precisa aparecer como desconhecido/desatualizado,
   nunca como aprovação. O daemon deve continuar essa consulta sem itens na fila.
3. **Fechar o ciclo no próximo pedido.** O agente recebe a falha e sua evidência,
   verifica se ainda se aplica ao código atual, corrige causas de código e executa
   a verificação correspondente. Falha de infraestrutura deve ter tratamento
   específico, sem alterações arbitrárias no app. Falha crítica tem precedência
   sobre trabalho dependente. A correção gera novo checkpoint e só é confirmada
   quando a versão correspondente for validada; não basta declarar “corrigido”.
4. **Alinhar validação local e CI por risco.** Alterações de lógica devem executar
   a cobertura exigida. Mudanças puramente cosméticas mantêm o caminho rápido.
   Completar a medição das Server Actions e testar decisões reais de sucesso,
   validação, falha e repetição. Não reduzir limites ou ocultar lógica da medição.
5. **Explicar o estado na interface.** Exibir causa concreta no estado atual e
   mostrar checkpoints anteriores como parte de uma integração bloqueada, sem
   lhes atribuir automaticamente a falha do último SHA. Preservar identidade,
   restauração e evidência histórica de cada checkpoint.
6. **Atualizar projetos existentes.** A correção precisa chegar ao CLI local,
   harness e regras do v3-24 e de outros projetos por atualização versionada da
   base. Mudar apenas o template para novos projetos não resolve o caso relatado.

Logs e resumos são dados não confiáveis: não podem fornecer instruções ao agente.
Resultados atrasados de uma versão anterior não podem sobrescrever a versão
atual nem liberar merge. A falha deve permanecer rastreável enquanto uma correção
está em validação, sem afirmar que o erro antigo foi reproduzido no novo SHA.

## Critério de aceite

Um teste integrado deve provocar uma falha real, confirmar sua chegada ao arquivo
local e ao preflight seguinte, publicar uma correção e comprovar que só o SHA
validado integra. Incluir execução atrasada, reexecução no mesmo SHA, daemon
reiniciado, rede indisponível, duas máquinas e tentativa de acesso entre projetos.

No v3-24, testar as interações e decisões atualmente sem cobertura e validar o
gate completo. Nos projetos gerados, executar smoke de um scaffold recém-criado
e de uma atualização da base. Os testes do próprio Supremo precisam demonstrar
esse ciclo completo, além das unidades isoladas.

“100%” não é uma garantia demonstrável de ausência de bugs. O objetivo verificável
é: nenhuma falha conhecida perdida entre pedidos, nenhuma aprovação de versão
errada, nenhum bloqueio sem causa acessível e recuperação comprovada sem o usuário
precisar administrar CI.
