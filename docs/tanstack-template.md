# Novos projetos com TanStack Start

O Supremo continua em Next.js 16.3.3. O template `tanstack-start-vite` 5.0.0 troca somente a estrutura dos aplicativos gerados. Não há migração de aplicações nem alteração de banco necessária para selecionar a stack.

## Seleção e versões

`src/lib/templates/stacks.ts` resolve o padrão da criação. As duas ações de criação gravam `template_version` no registro antes do provisionamento. O provisionador usa essa versão persistida; uma mudança posterior do padrão não troca a stack do projeto já selecionado. O arquivo local `.supremo/project.json` também registra `stack` e `scaffoldVersion`.

A CLI 1.8.0 confirma a identidade da stack pelas dependências, configuração e metadados. Evidências conflitantes são recusadas. O padrão de criação não é usado para interpretar um checkout sem metadados.

| Componente | Versão fixada |
| --- | --- |
| TanStack Start | 1.168.57 |
| TanStack Router | 1.170.38 |
| Gerador de rotas | 1.167.38 |
| Vite | 8.3.0 |
| React / React DOM | 19.2.8 |
| TanStack Query | 5.103.2 |
| Supabase SSR / JS | 0.12.5 / 2.112.4 |
| Zod | 4.5.4 |
| Tailwind | 4.3.3 |
| Nitro | 3.0.260903-beta |

Nitro é uma versão **prerelease**, usada e testada como adaptador do servidor de produção. O lockfile fixa as dependências transitivas. Node recomendado: **22 LTS, a partir de 22.13**; Node 24+ também é aceito pelo contrato de instalação. A execução real desta entrega foi validada no Node 22.22.1. Node 23 foi excluído após falha observada de reinicialização no desenvolvimento.

## Estrutura e comandos

As rotas ficam em `src/routes`; UI compartilhada em `src/components`; funcionalidades em `src/features`. Cada funcionalidade separa schemas seguros para o cliente (`*.schema.ts`), wrappers RPC (`*.functions.ts`) e implementações com proteção de import (`*.server.ts`). O template oferece autenticação Supabase, sessão por requisição, exemplo de mutação privada e autorização de organização no perfil team.

| Finalidade | Comando |
| --- | --- |
| Instalação reproduzível | `npm ci` |
| Desenvolvimento direto | `npm run dev` |
| Preview supervisionado | `npm run preview:ensure` / `npm run preview:status` / `npm run preview:stop` |
| Rotas em checkout limpo | `npm run routes:generate` |
| Tipos, incluindo geração de rotas | `npm run typecheck` |
| Qualidade | `npm run lint` |
| Testes / cobertura | `npm test` / `npm run test:coverage` |
| Auditoria | `npm run audit:security -- --strict` |
| Isolamento / navegador | `npm run test:rls` / `npm run test:e2e` |
| Produção com SSR e RPC | `npm run build` e `npm start -- --port 3000` |

O artefato Node fica em `.output/server/index.mjs`. No provedor Vercel já existente, `vercel.json` seleciona `tanstack-start` e Nitro produz o artefato correspondente. Não foi criado serviço novo de hospedagem nem reativado preview centralizado. Publicação remota não foi executada nesta entrega.

## Garantias e pontos alterados

- Gerador: `src/lib/templates/tanstack-start`; o controle do Supremo e suas rotas permanecem Next.
- Runtime: `packages/cli/src/framework-runtime.ts` concentra os comandos e a conversão explícita das **duas** variáveis públicas do Supabase. Não renomeia grupos de variáveis e não fornece credenciais administrativas ao app.
- Validação: o mesmo worker, classificador de risco, limites, fila e associação à revisão. O adaptador prepara rotas e mantém caches/builds fora do preview. Os testes reais incluem falhas intencionais de tipo, teste e segurança.
- Autoridade: os manifests publicados continuam verificando o conjunto completo de validadores. A release 4.0.9 foi congelada; 4.0.10 é o fallback Next com CLI atual. A release Start não é uma exceção de aprovação.
- Contexto do agente: `AGENTS.md` e `CLAUDE.md` específicos da stack, com as mesmas regras operacionais do Supremo.
- Segurança: validação Zod no servidor, identidade verificada, RLS, cliente Supabase por requisição, CSRF do Start instalado explicitamente, CSP com nonce, resposta privada sem cache público e erro real para imports proibidos. Só URL e chave pública do Supabase entram no bundle.

## Rollback do padrão

No ambiente **do Supremo**, defina `SUPREMO_NEW_PROJECT_STACK=nextjs` e publique essa configuração pelo fluxo habitual. Isso seleciona o template Next 4.0.10 somente nas criações seguintes. Para usar Start explicitamente, defina `SUPREMO_NEW_PROJECT_STACK=tanstack-start-vite`. Valores inválidos falham, sem selecionar outro framework silenciosamente.

Não é preciso alterar os registros já criados, restaurar código nem reaplicar migrations. O provisionamento continua usando a versão persistida na criação.

## Evidências

Resultados, condições de medição, falhas encontradas e limitações estão em [new-stack-validation.md](./new-stack-validation.md). Os runners reproduzíveis são `scripts/test-start-runtime.mts`, `scripts/test-start-validation.mts` e `scripts/test-start-crud.mts`. O último exige configuração explícita de um banco e serviços Supabase locais isolados; não infere credenciais de produção.
