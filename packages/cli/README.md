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

Comandos atuais: `bootstrap`, `checkpoint`, `daemon` e `sync`. Sem argumentos,
a CLI mostra ajuda. A antiga ponte MCP (`connect`/`mcp`) foi removida.
Checkpoints são locais; envio e integração rodam em background, sem esperar
CI para a próxima edição.

O token de git usado no clone é efêmero e nunca aparece em URL, argv, `.git/config`,
stdout ou log. `service_role` nunca é entregue.
