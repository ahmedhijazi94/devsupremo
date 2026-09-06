# Supremo Turn Lifecycle — template 3.8.0 / CLI 1.5.0

Implementação e verificação em 6 de setembro de 2026. Este documento descreve
o código local; não declara deploy do Supremo nem atualização de projetos remotos.

## Arquitetura e automação

O ciclo de edição continua `pedido → arquivos → Next dev/HMR → preview`.
O ciclo de confiabilidade usa `snapshot Git → validação isolada → checkpoint
publicado → CI → feedback persistido → recovery`. Os dois são independentes.

`turn-model.ts` define fases, classificação de falhas, recovery, critérios,
evidências e saúde. `turn-runtime.ts` executa os eventos e persiste recibos em
`.supremo/turns/`. Locks entre processos e leases de ferramentas coordenam
edição, captura, validação e restauração. Não há novo serviço distribuído.

O preflight consulta uma vez por pedido o endpoint autenticado
`/api/checkpoint/turn-context`. Ele reconcilia projeto, repositório, ambiente,
último checkpoint, feedback remoto e fila local. Cache antigo não vira
autorização atual. Identidade divergente, produção, ausência de autoridade e
reconciliação inconsistente bloqueiam a mutação; o preview pode continuar aberto.

O postflight captura uma árvore imutável usando índice Git separado, mantém o
HEAD/staging do usuário e registra `validationStatus=pending`. Não executa
build/CI na conclusão do turno. Um checkpoint só recebe aprovação local com
relatório estruturado da mesma SHA, base, árvore, projeto e ambiente.

## Background e checkpoints

Saves agendam validação com debounce; o worker reutiliza dependências em uma
worktree isolada, com saídas de build próprias e sem copiar credenciais do
workspace. O classificador escolhe verificações conforme a mudança.
Erro real de código prevalece sobre um aviso ambiental no mesmo log.

O daemon mantém workers separados para validação, diagnóstico e banco. Ele
publica os novos snapshots do lifecycle somente com prova correspondente; um gate local adiado
continua pendente e precisa dos gates remotos obrigatórios. Falhas locais não
são enviadas como aprovadas. Reiniciar o worker reprocessa verificações
interrompidas a partir da fila persistida.

Registros de filas legadas sem `validationStatus` preservam compatibilidade
de publicação e não possuem essa prova local nova. A CI remota continua
obrigatória; o rollout deve atualizar CLI, templates e daemon juntos.

O backend impede trocar a SHA de um ID de checkpoint já existente.
Resultados não integrados atualizam somente a SHA observada. Uma falha tardia
de A não marca B como falho. O merge confirmado mantém os checkpoints
ancestrais como integrados. O cron retenta capturar diagnósticos de projetos
com falha, inclusive enquanto todos os daemons estiverem offline.

## Recovery e limites de autocorreção

Uma pendência registra projeto, checkpoint, SHA local/remota, ambiente,
tipo de falha, evidência sanitizada, freshness, tentativa e resolução.
Os tipos incluem código, tipos, lint, build, unitário, integração, E2E, RLS,
segurança, migration, runtime, ambiente, dependência externa e desconhecido.

No próximo turno seguro, a pendência atual entra em `repairing` antes da
feature nova. O agente corrige e informa `repair-complete`; o worker valida
o snapshot corrigido. O protocolo mantém a feature bloqueada até comprovar o
reparo. Arquivos novos, evidência antiga ou outro projeto não resolvem a falha.

O padrão é três tentativas, configurável entre 1 e 10 em
`.supremo/lifecycle.json` (`max_auto_repair_attempts`). Esgotamento ou risco
fora da política exige atenção humana. Produção não recebe autocorreção.
Testes, workflows, thresholds, migrations e credenciais são protegidos
durante reparo; shells arbitrários e serviços externos não são atalhos.

O daemon registra e enfileira falhas, mas não inicia outro modelo sozinho.
A execução da correção usa o agente do usuário no próximo ponto seguro.
Mudanças sem hooks, ações manuais fora do protocolo e alterações maliciosas
no próprio harness não são isoladas por um sandbox novo do Supremo.

## Integração com o host e bootstrap

Os templates instalam hooks nativos `UserPromptSubmit`, `PreToolUse`,
`PostToolUse` e `Stop` para Claude Code e Codex; Claude também trata falha de
ferramenta. Os wrappers não aprovam permissões do host.

O status distingue configuração instalada/verificada de execução comprovada
por recibos vinculados ao hash da configuração, wrapper e sessão. Sem ciclo
comprovado a integração fica `assisted`; instalação incompatível fica
`unsupported`; um ciclo comprovado pode ser `enforced`. Esses recibos são
evidência local de execução, não atestação inviolável nem promessa de que o
host jamais será desativado.

O bootstrap verifica identidade, scripts, hooks Git exatos, adapter do host
selecionado, worker, daemon, banco de desenvolvimento e preview. Reporta
`ready`, `degraded` ou `not_ready`. Não mascara falha de instalação crítica.
Use `--host codex` ao preparar para Codex.

Codex exige revisão e confiança nos hooks pelo próprio host. Scripts
instalados não removem essa exigência. Interrupções, hooks desativados,
timeout/erro do host e ausência de `Stop` impedem garantir conclusão.
As integrações seguem as documentações oficiais de
[Codex](https://developers.openai.com/codex/hooks) e
[Claude Code](https://code.claude.com/docs/en/hooks).

## Critérios e QA

`.supremo/acceptance.json` liga critérios observáveis a checks nomeados e
arquivos de teste executáveis. Não infere automaticamente toda a semântica
de qualquer pedido: o agente implementador precisa escrever os critérios
e as provas relevantes. Ausência de evidência não equivale a sucesso.

Checks RLS nomeados são executados no banco efêmero do job obrigatório da CI.
Arquivos sem testes, com skip/todo ou não executados reprovam. O job produz
um artefato de aceitação ligado ao projeto, SHA, execução e tentativa. O
backend valida a origem, baixa um ZIP limitado em memória e persiste o
relatório no feedback. Recovery combina essas provas com as locais; um gate
genérico verde não substitui evidência do critério personalizado.

QA automático de baixo risco é permitido no preview local de development,
com usuários/dados sintéticos. Pagamentos, emails reais, produção e efeitos
externos sensíveis continuam fora dessa autorização.

## Evidência e escopo do E2E

`packages/cli/src/turn-e2e.test.ts` cobre os três prompts de produto do pedido,
recovery, offline/reconciliação, feedback antigo, isolamento de projeto,
concorrência, limite de reparos, postflight, debounce e preservação do Git.
`turn-process.test.ts` repete o fluxo com novos processos do sistema, HTTP,
Git e worktrees reais, assertions de comportamento e falha controlada de
busca. O terceiro processo recebe a pendência mesmo com cache local vazio,
revalida a correção e somente então adiciona a data. Os prompts de entrada
não contêm comandos operacionais. Host/modelo e backend remoto são fronteiras
controladas do teste; não são uma sessão real do modelo com GitHub Actions.

Testes complementares executam os wrappers gerados, retomada de daemon e
preview, falhas de instalação, backend, publicação e gates de segurança.
PostgreSQL descartável verifica acesso legítimo, negação de leitura/escrita/
exclusão cruzada, migrations idempotentes, rollback e bloqueio de produção.
Um scaffold team é instalado e passa pelos gates e QA desktop/mobile.

Resultados finais locais:

| Verificação | Resultado |
| --- | --- |
| Supremo | 1.061 testes passaram, 70 arquivos |
| Cobertura Supremo | 92,33% linhas; 93,71% branches; 94,44% funções |
| CLI | 403 testes passaram, 21 arquivos |
| Typecheck | Supremo e CLI sem erros; CLI agora também exigida na CI |
| Lint | Zero erros; cinco avisos já existentes fora deste trabalho |
| Auditoria estrita / bundle Gitleaks | Zero achados / zero vazamentos |
| Build de produção | Supremo e scaffold aprovados com Webpack |
| Distribuição | CLI 1.5.0 instalada por HTTP, com hash, sem registry |
| PostgreSQL descartável | RLS, retry, rollback, autoridade e bloqueio de produção aprovados |
| Scaffold team | 8 testes, 100% no pequeno baseline gerado; tipos/lint/auditoria aprovados |
| Browser QA | Desktop/mobile, formulário, modal, foco, tema e ausência de erros aprovados |
| HMR real | 77 ms nesta execução, estado do formulário e PID/URL preservados |

O build padrão com Turbopack encontrou restrição de abertura de porta neste
ambiente. O build Webpack é a comprovação de produção realizada. Nenhum
check foi removido para converter essa falha em sucesso.

`scripts/test-generated-worker.mts` foi conectado à CI: uma mudança cosmética
no scaffold passa por tipos, lint, cobertura, segurança e Playwright reais
na worktree isolada, sem build obrigatório e preservando HEAD/staging.
`scripts/test-preview-hmr.mts` reproduz a prova de HMR em um preview
descartável. No worker completo, RLS sem banco local permanece `deferred`,
sem ser apresentado como prova aprovada; a execução remota continua obrigatória.

O E2E externo completo — provisionar uma Central de Chamados real, confiar
os hooks no host, usar três sessões reais e observar GitHub/Supabase — precisa
ser executado no ambiente integrado. A suíte local não substitui essa prova.
Nesta máquina Claude Code não estava autenticado. Não foram alterados
recursos de produção nem desativada a revisão de confiança do Codex.

## Entrega a projetos existentes

O template e o bundle distribuído da CLI precisam ser publicados pelo
Supremo para novos bootstraps. Projetos existentes precisam receber a base
atualizada, reinstalar seus adapters e atualizar o daemon quando o executável
em execução for anterior ao protocolo. Preserve preview, porta, banco e
alterações do usuário. Este checkout não migra silenciosamente esses apps.
