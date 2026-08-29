# Supremo — Agents Context

## O que é este projeto
**Supremo** é uma plataforma web para gerenciar e criar apps via IA. É o "Lovable profissional" — cada prompt gera código, testes rodam automaticamente e um commit é criado após aprovação.

## Stack
- **Framework:** Next.js 15 (App Router) + TypeScript strict
- **Estilo:** Tailwind CSS + shadcn/ui
- **Auth:** Supabase Auth (GitHub OAuth + Google OAuth)
- **Database:** Supabase (PostgreSQL + RLS em todas as tabelas)
- **Deploy:** Vercel
- **Preview:** Cloudflare Pages (projetos gerados)
- **MCP Server:** Cloudflare Worker (expõe contexto aos MCPs)
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
- TypeScript check: `tsc --noEmit` — zero erros
- ESLint: zero warnings
- Unit tests: cobertura mínima 80% (Vitest)
- E2E: fluxos críticos cobertos (Playwright)
- Security scan: zero vulnerabilidades críticas

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

## Funcionalidades Implementadas
- [ ] Auth (GitHub + Google OAuth)
- [ ] Dashboard multi-projeto
- [ ] MCP Server (contexto de projeto)
- [ ] Pipeline de testes automatizada
- [ ] Gerenciamento de contas GitHub/Supabase
- [ ] Preview Cloudflare

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
