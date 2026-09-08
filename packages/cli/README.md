# supremo-cli

CLI do [Supremo](https://supremo-three.vercel.app). Prepara o workspace local de
um projeto criado no Supremo — sem instalar nada globalmente.

Copie o comando de bootstrap exibido pelo seu Supremo. Ele instala o pacote
servido por aquela versão do Supremo e identificado pelo hash do conteúdo.
Depois do bootstrap, os scripts do projeto usam a CLI incluída no repositório,
sem depender do registry para checkpoint, daemon ou sync.

O comando:

1. inicia um **device flow** e mostra um link + código;
2. você autoriza no navegador (logado no Supremo) — nenhum segredo vai pelo terminal;
3. o CLI **clona** o repositório (cria a pasta automaticamente na pasta atual),
   escreve o `.env.local` (só variáveis públicas), instala as dependências,
   configura os git hooks e prepara a infraestrutura local. Não executa uma suíte
   de testes no bootstrap; o baseline pode ser solicitado com `setup:local -- --validate-baseline`.

O bootstrap prepara o daemon, o preview persistente e os hooks de turno.
Abra a pasta criada no agente e descreva a funcionalidade. Os adapters de
Claude Code e Codex executam preflight/postflight e mantêm recibos locais.
No Codex, os hooks precisam ser revisados e confiados no próprio host.
`npm run supremo:resume` continua disponível para diagnóstico manual.

### Opções

- `--url <url>` — URL do seu Supremo (obrigatório).
- `--dir <dir>` — pasta-base onde criar o projeto (padrão: a pasta atual).
- `--host <name>` — `claude-code` (padrão) ou `codex`, para verificar o agente escolhido.
- Consulte `supremo bootstrap --help` para as opções da versão instalada.

Comandos atuais: `bootstrap`, `authorize`, `turn`, `host`, `engine`, `checkpoint`, `daemon`, `sync`, `db`, `jobs` e `secrets`. Sem argumentos,
a CLI mostra ajuda. A antiga ponte MCP (`connect`/`mcp`) foi removida.
Checkpoints são locais; envio e integração rodam em background, sem esperar
CI para a próxima edição.

### Turnos e evidências (1.7.0)

`supremo host install` instala os adapters preservando hooks e permissões
existentes. `supremo host status` diferencia instalação válida de execução
comprovada; sem recibos, a integração é `assisted`, não `enforced`.

Os hooks chamam `supremo turn preflight`, `before-mutation`, `mutation` e
`complete`. O preflight reconcilia backend/cache/fila; o postflight captura o
estado sem alterar o HEAD ou o staging do usuário. O padrão é implementar,
entregar o preview e devolver o controle. O worker executa validação adaptativa
em background: tipos, lint, segurança e testes afetados para mudanças pequenas;
alterações sensíveis recebem verificações adicionais. Ausência de evidência fica
pendente, nunca aprovada. A CI continua exigindo todos os gates obrigatórios.
O registro do checkpoint é sincronizado mesmo com validação pendente ou falha.

`supremo turn status` mostra estado persistido. `repair-start` e
`repair-complete` delimitam tentativas explícitas de reparo restrito.
O próximo pedido recebe a pendência em um host ativo e com hooks confiados.
Em desenvolvimento autorizado, falhas anteriores são diagnósticos e não bloqueiam
edições ou checkpoints. O agente pode preparar correções de segurança, migrations
versionadas e testes de regressão a pedido do usuário, sem iniciar reparo restrito.
A autorização de operações no banco e os gates de publicação continuam obrigatórios.
A correção só é resolvida com evidência da mesma revisão;
não se apaga uma falha porque houve uma edição. A autocorreção pode chamar o
runner compatível autorizado, dentro dos limites de tentativas, tempo e arquivos.
Ela propõe um patch isolado; o motor só o aplica se o workspace permanecer igual.

`supremo engine status` mostra política e autocorreção. `engine pause` pausa
apenas a autocorreção; `engine resume` a retoma. `engine on-request` é a opção
explícita para testes locais sob demanda; `engine automatic` restaura o padrão
adaptativo. Os limites ficam em `.supremo/lifecycle.json`.
`supremo turn validate` solicita a validação local isolada explicitamente.
Esgotamento da autocorreção fica visível e não impede uma nova correção solicitada.
O contrato opcional `.supremo/acceptance.json` liga critérios a testes unitários,
E2E ou RLS nomeados; critérios sem prova não são aprovados. Testes RLS que
dependem de banco isolado continuam pendentes para os gates remotos.

O token de git usado no clone é efêmero e nunca aparece em URL, argv, `.git/config`,
stdout ou log. `service_role` nunca é entregue.

### Banco de desenvolvimento

- `supremo db status`: classificação JSON consultada no Supremo autenticado.
- `supremo db migrate`: aplica migrations versionadas apenas no development
  registrado, verificando o vínculo e o banco usado pelo preview.
- `supremo db anonymous-auth`: habilita identidade anônima sob demanda apenas no
  development, preservando as demais opções de segurança e verificando prontidão.
- `supremo db inspect`: consulta tabelas, colunas, índices, relações e políticas.
- `supremo db query --sql 'SELECT status, count(*) FROM public.tickets GROUP BY status'`:
  consulta dados reais com SQL restrito a leitura.
- `supremo db logs --source postgres --minutes 60 --level error`: consulta eventos.
- `supremo db report`: reúne estrutura, métricas e logs; informa se faltam evidências.

`.supremo/database.json` é um snapshot informativo. A autorização vem do servidor
em cada operação. Escritas em produção ou bancos sem classificação são recusadas;
o dono pode consultá-los em leitura com vínculo confirmado. Não há fallback para
armazenamento local nem para consulta privilegiada. Perguntas e diagnósticos não
criam checkpoints nem agendam testes. Respostas identificam ambiente, horário,
limites e paginação; campos reconhecidos de credenciais são ocultados.

A partir da CLI 1.3.1, o agente envia esses pedidos pela fila local
`.supremo/database-queue/`. O daemon autorizado acessa o keychain e o servidor;
a fila contém apenas a operação e o prazo, nunca credenciais. O worker de banco
é independente do upload de checkpoints e de seu backoff. Uma resposta local
não substitui a validação de autorização no servidor.

Na versão 1.7.0, a identidade no keychain vincula credencial, projeto e origem do
Supremo. Instalações antigas sem essa prova precisam de
`supremo authorize --url <origem confiável>` no checkout existente; nenhum segredo
antigo é enviado para uma URL inferida de arquivo local. Isso não reclona nem
altera o preview. O fluxo de autorização informa a conclusão no navegador.

Ao atualizar um projeto que tem um daemon anterior em execução, atualize a CLI
incluída em `tools/supremo-cli` e reinicie somente o daemon no terminal autorizado
(`npm run daemon:stop`, depois `npm run daemon:ensure`). Não é necessário refazer
bootstrap completo, trocar banco ou reiniciar o preview. Um daemon antigo é diagnosticado
imediatamente, sem tentar obter credenciais pelo processo do agente.

### Chaves de integrações

O agente solicita campos nomeados; o dono preenche no projeto do Supremo:

```sh
supremo secrets request PAYMENTS_API_KEY --reason 'Autenticar a integração de pagamentos' --target supabase --environment development
supremo secrets status
```

Os destinos são secrets de Edge Functions do Supabase ou variáveis criptografadas
da Vercel em um único ambiente explícito. O formulário mostra o nome exato, a
finalidade e o destino. A CLI recebe somente metadados e o link do formulário;
não aceita nem devolve valores. A confirmação exige sucesso do provedor e registro
persistido. Na Vercel, a chave fica disponível no próximo deploy desse ambiente.

### Rotinas do aplicativo

`supremo jobs apply` lê o manifesto versionado `supabase/jobs.json`. O formato
inicial permite atualizar campos de negócio por filtros, com limite de linhas,
em uma tabela com RLS, chave primária e tipos suportados. O agendamento usa cron
de cinco campos em UTC. Não aceita SQL livre, campos de credenciais, mudanças de
ownership nem rotinas arbitrárias de Edge Functions.

```sh
supremo jobs list
supremo jobs history --job-id mark-overdue
supremo jobs apply
supremo jobs pause --job-id mark-overdue
supremo jobs resume --job-id mark-overdue
supremo jobs remove --job-id mark-overdue
```

Alterações são permitidas apenas no development registrado; consultas usam o
ambiente confirmado do projeto. O motor administra somente seus próprios jobs.
