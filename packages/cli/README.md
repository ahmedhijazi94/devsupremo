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
   configura os git hooks e roda o baseline (`npm run verify`).

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

Comandos atuais: `bootstrap`, `turn`, `host`, `checkpoint`, `daemon`, `sync` e `db`. Sem argumentos,
a CLI mostra ajuda. A antiga ponte MCP (`connect`/`mcp`) foi removida.
Checkpoints são locais; envio e integração rodam em background, sem esperar
CI para a próxima edição.

### Turnos e evidências (1.5.0)

`supremo host install` instala os adapters preservando hooks e permissões
existentes. `supremo host status` diferencia instalação válida de execução
comprovada; sem recibos, a integração é `assisted`, não `enforced`.

Os hooks chamam `supremo turn preflight`, `before-mutation`, `mutation` e
`complete`. O preflight reconcilia backend/cache/fila; o postflight captura o
estado sem alterar o HEAD ou o staging do usuário. Saves têm debounce; testes
e builds usam uma cópia Git isolada, preservando o preview.

`supremo turn status` mostra estado persistido. `repair-start` e
`repair-complete` são comandos internos do agente para tentativas de reparo.
O próximo pedido recebe a pendência automaticamente em um host ativo e com
hooks confiados. A correção só é resolvida com evidência da mesma revisão;
produção, provas ausentes, concorrência e diagnósticos antigos bloqueiam o
reparo. O daemon enfileira e valida; não inicia outro modelo por conta própria.

Configure `.supremo/lifecycle.json` com
`{"max_auto_repair_attempts":3}` (1–10). Esgotamento exige atenção humana.
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

`.supremo/database.json` é um snapshot informativo. A autorização vem do servidor
em cada escrita. Produção e bancos sem classificação são recusados; não há fallback
para armazenamento local. O fluxo não espera CI nem reinicia o preview.

A partir da CLI 1.3.1, o agente envia esses pedidos pela fila local
`.supremo/database-queue/`. O daemon autorizado acessa o keychain e o servidor;
a fila contém apenas a operação e o prazo, nunca credenciais. O worker de banco
é independente do upload de checkpoints e de seu backoff. Uma resposta local
não substitui a validação de autorização no servidor.

Ao atualizar um projeto que já tem o daemon 1.3.0 em execução, atualize a CLI
incluída em `tools/supremo-cli` e reinicie somente o daemon no terminal autorizado
(`npm run daemon:stop`, depois `npm run daemon:ensure`). Não é necessário refazer
bootstrap, trocar banco ou reiniciar o preview. Um daemon antigo é diagnosticado
imediatamente, sem tentar obter credenciais pelo processo do agente.
