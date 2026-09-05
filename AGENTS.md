# Supremo — Agents Context

## O que é este projeto
**Supremo** estrutura e acompanha apps desenvolvidos diretamente no agente escolhido pelo usuário. Prioridade: uso pessoal, código e banco próprios, preview local rápido e validações em background. Não oferece chat próprio.

## Stack
- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript strict
- **Estilo:** Tailwind CSS + shadcn/ui
- **Auth:** Supabase Auth (GitHub OAuth + Google OAuth)
- **Database:** Supabase (PostgreSQL + RLS em todas as tabelas)
- **Deploy:** Vercel
- **Preview:** servidor local persistente supervisionado pelo harness do projeto
- **Integração:** CLI bootstrap/checkpoint/daemon com autenticação por dispositivo
- **Testes:** Vitest + Playwright + React Testing Library

## Arquitetura — Regras Absolutas

### Segurança (NUNCA violar)
- TODA validação ocorre em Server Actions ou Route Handlers — NUNCA no client
- NUNCA expor secrets ao client bundle (process.env sem NEXT_PUBLIC_)
- RLS ativo em TODAS as tabelas do Supabase sem exceção
- Verificações de admin/role sempre via `auth.jwt()` claims — NUNCA via coluna escalável pelo client
- NUNCA confiar em dados vindos do client sem revalidar no servidor
- CSRF protection em todos os forms com Server Actions
- Rate limiting via middleware em todas as rotas autenticadas
- Input sanitization no servidor antes de qualquer query

### Código
- TypeScript strict: zero `any`, tipos explícitos em tudo
- Zero lógica de negócio em componentes React (apenas UI)
- Server Actions para mutações, Route Handlers para APIs externas
- Zod para validação de todos os inputs do servidor
- Tratamento de erro explícito — sem silenciar erros com catch vazio

### Banco de Dados
- Migrations versionadas em `/supabase/migrations/`
- RLS template obrigatório em toda nova tabela:
  ```sql
  ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
  ```
- Foreign keys com ON DELETE CASCADE ou RESTRICT explícito
- Índices em todas as foreign keys e colunas de busca frequente
- `created_at` e `updated_at` em todas as tabelas

### Testes (obrigatórios antes de todo commit)
- `npm run typecheck` — zero erros
- `npm run lint` — zero erros
- `npm run test:coverage` — cobertura mínima 85%, o threshold reprova o build
- `npm run audit:security -- --strict` — zero achados CRITICAL ou HIGH
- `npm run build` — build de produção

A cobertura é medida sobre o código que carrega lógica de decisão. Adaptadores
de I/O ficam de fora do denominador porque um teste unitário neles exercitaria
o mock, não o código; a cobertura deles vem do E2E e dos testes de RLS.

## Estrutura de Diretórios
```
src/
├── app/
│   ├── (auth)/          # Rotas públicas (login, callback)
│   ├── (protected)/     # Rotas autenticadas
│   └── api/             # Route handlers (webhooks, APIs externas)
├── components/
│   ├── ui/              # shadcn/ui base components
│   └── [feature]/       # Componentes de feature
├── lib/
│   ├── supabase/
│   │   ├── server.ts    # Client SSR (cookies)
│   │   └── client.ts    # Client browser (limitado)
│   ├── validations/     # Zod schemas
│   └── utils.ts
├── actions/             # Server Actions (mutações)
└── types/               # TypeScript types globais
supabase/
├── migrations/          # SQL migrations versionadas
└── seed.sql
```

## Fluxo atual
- O usuário abre o projeto no seu agente; as regras ficam em arquivos locais.
- Bootstrap prepara o projeto; checkpoints locais são publicados pelo daemon.
- CI e integração seguem em background: nunca aguardar CI para continuar desenvolvendo.
- Preservar preview saudável, porta, processo e ambiente. Não reiniciar por rotina.
- `src/lib/github/` integra GitHub; `src/lib/projects/` resolve projetos autorizados.
- `src/lib/checkpoint/` valida dispositivos, grants e checkpoints.
- `src/lib/templates/` gera estrutura, regras, testes e supervisor local.
- `src/lib/supabase/admin.ts` cria o cliente privilegiado apenas no servidor.
- Toda operação privilegiada deve validar dono e escopo; IDs do cliente não autorizam acesso.
- Desenvolvimento e produção precisam de bancos distintos; link existente não comprova ambiente seguro.
- Histórico de migrations antigas é preservado; o transporte MCP v1 foi removido.

## Decisões de Arquitetura Tomadas
- Supabase Auth ao invés de NextAuth (integração nativa com RLS)
- Server Actions ao invés de API Routes para mutações (type-safe, CSRF automático)
- Vitest ao invés de Jest (mais rápido, ESM nativo, compatível com Next.js 15)
- shadcn/ui ao invés de biblioteca de componentes externa (controle total)

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
