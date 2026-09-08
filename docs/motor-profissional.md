# Motor profissional — Supremo 4.0

## Contrato de experiência

**Prompt → implementação → preview → controle devolvido.** O agente não aguarda
testes, build, browser ou GitHub para encerrar uma edição comum. A fila durável
registra o checkpoint; validação, publicação e integração continuam em background.

O preview mantém processo, endereço e estado de formulário quando o HMR permite.
Uma falha antiga continua visível como diagnóstico, sem impedir a próxima edição.
Ambiente desconhecido não autoriza operações privilegiadas no banco.
Em desenvolvimento autorizado, o agente também pode preparar correções de segurança,
migrations versionadas e testes de regressão. Os limites do executor de autocorreção
não impedem esse trabalho solicitado. Preparar uma mudança não aprova sua publicação
nem concede acesso a outro ambiente.

## Validação independente

- O worker executa checks adaptativos sobre uma revisão Git imutável, em uma
  worktree separada. Prioriza o snapshot recente, cancela trabalho substituído,
  limita duração/saída e só reutiliza evidência da mesma revisão, base e ambiente.
- Alterações pequenas recebem tipos, lint, segurança e testes afetados. Ausência
  de teste relacionado fica pendente; não vira teste aprovado.
- No GitHub, cobertura, RLS, E2E, build, auditoria e segredos são obrigatórios.
  Jobs vazios, ignorados ou cancelados não aprovam a integração.
- O servidor compara a árvore completa da revisão com os validadores publicados
  pelo motor: workflows, scripts, configurações, comandos e dependências travadas.
  O manifesto autoritativo está no release do motor, não no app avaliado.
- Instalação de dependências sem hooks; rejeição de dependências que sombreiam
  ferramentas ou substituem seus executáveis. A base pode ser atualizada pelo
  fluxo próprio do Supremo, preservando funcionalidades e dependências extras.
- A aprovação consulta jobs do workflow correto e do SHA atual. Auto-merge legado
  é desarmado; ambos os modos integram com SHA esperado após revalidar a política.
- CodeQL tem uma barreira adicional: exige o resultado da aplicação oficial do
  GitHub para a revisão atual e revalida antes do merge. Quando configurado,
  resultado ausente ou pendente aguarda; falha ou falta de permissão bloqueia
  integração. Indisponibilidade de licença exige confirmação explícita de ambos
  os produtos de segurança desativados em repositório privado. Os outros gates
  continuam obrigatórios. A ativação usa o endpoint oficial de default setup.

O auditor usa AST para operações reconhecíveis de autenticação, validação e acesso
a dados. Também verifica contratos explícitos de RLS, foreign keys e índices.
Isso complementa testes reais; não constitui prova universal de segurança.
Arquivos usados em validação e propostas são abertos e conferidos pelo mesmo
descritor, com limite de leitura e recusa de trocas, links ou alterações durante
a leitura. Package e lock usam exatamente os bytes já verificados. A CLI usa
Zod sem geração dinâmica de código; a prova e a interpretação dos alertas
upstream estão em [codeql-zod-cli.md](./codeql-zod-cli.md).

## Checkpoints, restore e autocorreção

O restore tem lease, vínculo ao projeto e dispositivo, confirmação transacional e
fila persistente de reenvio. A perda de uma resposta não duplica a restauração.
O resultado fica registrado antes de se confirmar sucesso. As branches são
preservadas quando não existe uma exclusão atômica segura contra avanço concorrente.

A autocorreção usa o agente compatível registrado no projeto. Ele produz uma
proposta estruturada com ferramentas restringidas; o motor aplica e testa essa
proposta em uma cópia separada. O trabalho atual precisa continuar idêntico e sem
edição ativa para receber o patch. Uma interrupção entre aplicar e registrar o
checkpoint é recuperada por journal, sem reaplicar o patch às cegas.

Tentativas, duração, tamanho e número de arquivos têm limites. Tentativas também
são limitadas ao longo de checkpoints produzidos pela própria autocorreção.
Falhas de segurança, ambiente, RLS ou migrations não são reparadas cegamente por
esse executor de correções comuns. Um diagnóstico continua pendente quando falta
autoridade, ferramenta compatível ou prova suficiente.

## Controles

Os padrões são testes automáticos adaptativos e autocorreção habilitada. O host
precisa estar registrado; ausência ou incompatibilidade é mostrada como indisponível.

```sh
supremo engine status
supremo engine pause       # pausa autocorreção; testes continuam
supremo engine resume
supremo engine on-request  # opção explícita para testes locais sob demanda
supremo engine automatic
```

Os limites ficam em `.supremo/lifecycle.json`; o estado fica em
`.supremo/validation/repair/status.json`. Pausar o motor local não desativa os gates
de publicação. O Codex possui limites operacionais de tempo/tentativas/bytes;
o limite monetário nativo do runner está disponível no Claude.

## Dados, logs e investigação

O agente pode consultar o banco real vinculado ao projeto sem receber a credencial
do provedor. A CLI solicita ao daemon uma leitura autenticada; o servidor confirma
dono, projeto, referência e ambiente novamente em cada chamada ao Supabase.

```sh
supremo db inspect
supremo db inspect --table tickets
supremo db query --sql 'SELECT status, count(*) AS total FROM public.tickets GROUP BY status'
supremo db logs --source postgres --minutes 60 --level error
supremo db report
```

Perguntas e investigações usam esse canal sem disparar testes, migrations ou
checkpoints. A resposta identifica ambiente, momento da consulta, limites e
paginação. O agente deve distinguir dados observados de hipóteses e resultados
parciais de relatórios completos; conteúdo dos registros nunca vira instrução.

Consultas de aplicação aceitam um subconjunto de SELECT/WITH em tabelas public.
O endpoint do provedor usa papel somente de leitura e transação READ ONLY, com
timeout; não existe fallback para o endpoint privilegiado. A inspeção inclui
colunas, relações, índices e políticas RLS. Logs têm serviço, período e volume
limitados. Credenciais e campos sensíveis reconhecidos são ocultados antes da
resposta. Leituras de produção são permitidas ao dono com vínculo confirmado;
alterações de banco continuam no fluxo separado de migrations e autorização.

## Segredos e rotinas

O agente solicita nomes, finalidade, destino e ambiente pelo comando `secrets request`.
O projeto exibe campos de senha com os nomes exatos. Somente o dono autenticado
envia o valor pelo formulário; o servidor revalida o vínculo e o encaminha aos
secrets de Edge Functions do Supabase ou à Vercel no ambiente escolhido. A tabela,
a CLI e o histórico do Supremo recebem apenas metadados. Uma falha de confirmação
mantém o pedido pendente; o destino não é inferido no momento de colar a chave.

Rotinas declarativas ficam em `supabase/jobs.json`, com cron UTC, filtros e limites
de atualização. A CLI oferece aplicação, consulta, histórico, pausa, retomada e
remoção. Escritas exigem development registrado; jobs de terceiros ficam fora do
escopo. A primeira versão cobre atualização periódica de campos de negócio em
tabelas compatíveis. SQL arbitrário, alteração de ownership e execução genérica
de Edge Functions não fazem parte desse contrato.

## Evidência da implementação

Na validação final local, passaram 1.475 testes do motor e 566 da CLI. A cobertura
do código de decisão medido foi de 94,90% em linhas, 94,62% em branches e 94,78%
em funções. Tipos e lint passaram; a auditoria estrita não encontrou CRITICAL/HIGH
e manteve 13 MEDIUM de contexto de autorização para revisão. O build local de
produção passou com Webpack; a CI mantém o build padrão com Turbopack.

Em 08/09/2026, pg_cron oficial 1.6.7 em PostgreSQL 14.17 executou uma rotina pelo
relógio: houve alteração da linha de teste e registro `succeeded`. O papel executor
não tinha SUPERUSER nem BYPASSRLS. Foram provados limites por coluna/linha,
pausa/retomada/remoção, revogação e recusa de alterações em policies, índices,
funções, triggers e rewrite rules. Esse teste descobriu e corrigiu o uso indevido
de BEGIN/COMMIT dentro da transação fornecida pelo background worker do pg_cron.
Os hashes de integridade de estrutura e código usam SHA-256, inclusive no banco.
O script `test-database-jobs.mts` também é exigido na CI com PostgreSQL 17 e a
extensão real, compilada de tag/commit oficiais fixados em container descartável.

O provedor precisa permitir criação de papéis e uso das funções do pg_cron; o
executor de configuração também consulta configurações do banco. Ausência dessas
capacidades é erro explícito. Remover um job retira agendamento e permissões;
preserva o papel NOLOGIN e a função sem permissão de execução em vez de apagar
objetos por cascata.

Os testes locais do motor incluem integrações de Git, HTTP, processos, cancelamento
de descendentes, interrupção de restore e aplicação de reparo. O histórico completo
de migrations 001–024 foi aplicado em PostgreSQL descartável, com concorrência,
RLS e verificação dos novos índices. A migration de secrets preservou pedidos
antigos e bloqueou acesso cruzado entre donos/projetos, escrita anônima e destinos
incompletos. Nenhum secret real foi enviado aos provedores durante os testes.

Um scaffold real passou instalação com `--ignore-scripts`, tipos, lint, testes,
cobertura, auditoria e build de produção. O worker real executou validação adaptativa
da revisão em 2,43 s. No teste de Next/browser real, a devolução de controle levou
328 ms; duas edições preservaram formulário, endereço, processo, HEAD e staging.
Esses tempos excluem raciocínio do modelo; o backend desse teste foi controlado.

O runner Codex também retornou uma proposta real válida para código sintético em
11,84 s, sem aplicar nada em um app do usuário. Isso comprova o transporte e as
restrições do runner; não é um benchmark de criação de aplicativos completos.

O provider e o serviço de inspeção também foram exercitados no banco real da
Central de Chamados: três tabelas public com RLS, consulta agregada de chamados e
relatório completo de estrutura/métricas/logs. Uma segunda leitura encontrou dois
eventos, sem expor seu conteúdo no relatório de QA. O banco confirmou papel
`supabase_read_only_user`, transação somente de leitura e timeout de 8 segundos.
Nenhum registro ou esquema do app foi alterado.
Essa evidência remota foi colhida em 06/09/2026. Na retomada em 08/09, o vínculo
daquele projeto não estava disponível para uma nova consulta de capacidades.
Ela não substitui a rodada de E2E após implantar este release e atualizar a base.

## Instalação e limites observados

Este release usa template 4.0.0, baseline 3.0.0 e CLI 1.7.0. Aplicar as migrations
pendentes em ordem antes de disponibilizar os novos endpoints, publicar o motor e
usar **Atualizar base** nos projetos existentes. Bases antigas não recebem aprovação
da nova política até sua atualização; o preview local não depende dessa aprovação.

A identidade privada agora vincula projeto, credencial e origem do Supremo no
keychain. Credenciais antigas sem prova de origem exigem reautorização com
`supremo authorize --url <origem confiável>`, no checkout existente. Isso não
reclona o projeto nem reinicia o preview. O motor não migra um segredo antigo
confiando somente na URL de um arquivo editável pelo agente.
Uma escolha anterior de testes sob demanda é preservada; use
`supremo engine automatic` para ativar o fluxo automático nesse projeto.

Restore recupera código na máquina original; não reverte dados do banco. A
reconciliação por webhook é imediata, com fallback diário na configuração atual.
A worktree separa artefatos de build, mas não é uma sandbox de sistema operacional.
Hooks dependem do suporte e da confiança concedida pelo host: configuração sem
recibos reais não aparece como proteção integral. Permissões de administrador no
GitHub ou no banco continuam fora da autoridade exclusiva do motor.

Nenhum desses controles promete ausência absoluta de bugs ou segurança perfeita.
