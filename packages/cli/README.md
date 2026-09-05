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

O bootstrap prepara o daemon e o preview persistente. Abra a pasta criada
no seu agente e siga o `AGENTS.md` gerado. Para retomar uma sessão, use
`npm run supremo:resume`; ele preserva um preview saudável.

### Opções

- `--url <url>` — URL do seu Supremo (obrigatório).
- `--dir <dir>` — pasta-base onde criar o projeto (padrão: a pasta atual).
- Consulte `supremo bootstrap --help` para as opções da versão instalada.

Comandos atuais: `bootstrap`, `checkpoint`, `daemon`, `sync` e `db`. Sem argumentos,
a CLI mostra ajuda. A antiga ponte MCP (`connect`/`mcp`) foi removida.
Checkpoints são locais; envio e integração rodam em background, sem esperar
CI para a próxima edição.

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
