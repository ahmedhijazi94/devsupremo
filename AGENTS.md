# Supremo — Agents Context

## O que é este projeto
**Supremo** é uma plataforma web para gerenciar e criar apps via IA. É o "Lovable profissional" — cada prompt gera código, testes rodam automaticamente e um commit é criado após aprovação.

## Stack
- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript strict
- **Estilo:** Tailwind CSS + shadcn/ui
- **Auth:** Supabase Auth (GitHub OAuth + Google OAuth)
- **Database:** Supabase (PostgreSQL + RLS em todas as tabelas)
- **Deploy:** Vercel
- **Preview:** WebContainer no navegador, com sync incremental por commit
- **MCP Server:** endpoint Streamable HTTP em `/api/mcp`, autenticado por
  token pessoal — roda no próprio app, não em worker separado
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

## Funcionalidades Implementadas
- [x] Auth (GitHub + Google OAuth)
- [x] Dashboard multi-projeto
- [x] MCP remoto com token por usuário — conecta de qualquer máquina
- [x] Regras do projeto servidas pelo MCP (agents.md, CLAUDE.md, SECURITY.md)
- [x] Loop branch → PR → gates → merge, com espera real do CI
- [x] Gerenciamento de contas GitHub/Supabase
- [x] Scaffold com testes de RLS gerados por tabela
- [x] Preview via WebContainer com sync incremental
- [x] Histórico de mudanças com status de pipeline
- [ ] Preview deploy compartilhável por PR (Vercel)
- [ ] Erros de runtime do preview realimentando o agente
- [ ] Workspace de três painéis (conversa · preview · diff)

## Estrutura do MCP

```
src/lib/mcp/
├── tokens.ts      # geração, hash e resolução de token → usuário
├── repository.ts  # acesso a dados; TODA função exige userId explícito
├── github.ts      # branch, commit, PR, checks, logs, proteção de branch
├── sql-guard.ts   # recusa DDL em leitura e tabela sem RLS em migration
└── server.ts      # ferramentas e as regras declaradas no handshake
```

Regra que não se quebra: o `userId` vem sempre do token resolvido, nunca do
cliente. O cliente de dados usa service role porque não há cookie numa chamada
de MCP — por isso o filtro por dono no repositório é a única fronteira entre
contas, e precisa estar em toda query.

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
