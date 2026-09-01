# supremo-cli

CLI do [Supremo](https://supremo-three.vercel.app). Prepara o workspace local de
um projeto criado no Supremo — sem instalar nada globalmente.

```bash
# rode dentro da pasta onde você guarda seus projetos
npx supremo-cli@latest bootstrap <project-id> --url https://supremo-three.vercel.app
```

O comando:

1. inicia um **device flow** e mostra um link + código;
2. você autoriza no navegador (logado no Supremo) — nenhum segredo vai pelo terminal;
3. o CLI **clona** o repositório (cria a pasta automaticamente na pasta atual),
   escreve o `.env.local` (só variáveis públicas), instala as dependências,
   configura os git hooks e roda o baseline (`npm run verify`).

Depois: `cd <projeto> && npm run dev`.

### Opções

- `--url <url>` — URL do seu Supremo (obrigatório).
- `--dir <dir>` — pasta-base onde criar o projeto (padrão: a pasta atual).
- `--start` — já sobe o `npm run dev` ao final.

O token de git usado no clone é efêmero e nunca aparece em URL, argv, `.git/config`,
stdout ou log. `service_role` nunca é entregue.
