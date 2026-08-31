# Runtime de desenvolvimento por projeto (Codespaces)

Migração incremental do motor de dev do Supremo. Objetivo: velocidade de dev
próxima do Lovable (dev server + HMR) sem perder segurança, isolamento, RLS,
auditoria e controle do Supremo.

## Arquitetura ANTES (auditada)

- **Host**: Next.js 16 (App Router) na Vercel, **serverless** (`/api/mcp` com
  `runtime='nodejs'`, `maxDuration=300`). Supabase (Postgres + Auth + RLS).
- **MCP**: Streamable HTTP em `/api/mcp`, auth por token `sup_…`
  (`resolveMcpToken`), server por requisição (`createSupremoMcpServer(userId)`).
- **Como o MCP "executa"**: NÃO executa código. Escreve arquivos via **GitHub
  API** (Octokit), aplica SQL via **Supabase Management API**. O "motor" de
  build/preview é **GitHub Actions** (gates) + **Vercel** (build + preview em
  iframe). Cada ciclo = round-trips de API + fila do Actions + build da Vercel =
  minutos. **Esse é o motor lento.**
- **Isolamento**: RLS (`auth.uid()`) + `requireProjectOwner` na web; token +
  service-role com filtro por `user_id` no MCP. Tokens encriptados (AES-256-GCM).

## Arquitetura DEPOIS (alvo)

Cada projeto ganha um **Codespace** próprio (repo A → Codespace A → preview A).
O agente edita arquivos no filesystem do Codespace; dev server/HMR dá o preview;
testes rodam em background dentro do Codespace e reportam ao Supremo. GitHub
segue como versionamento; Supabase como banco; Supremo como orquestrador.

## Três achados que definem o desenho (o difícil, honesto)

1. **O GitHub Codespaces NÃO tem API de executar comando num ambiente rodando.**
   A REST dá só lifecycle (create/start/stop/delete/list). Para editar arquivos +
   subir dev server + rodar testes DENTRO, é preciso um **daemon do Supremo
   dentro do Codespace** (instalado via `.devcontainer`), expondo uma API HTTP
   autenticada numa porta encaminhada. O MCP manda uma TAREFA a esse daemon (não
   micro-ops). Alternativa (`gh codespace ssh`) exige host persistente — ver #2.

2. **O Supremo é serverless (Vercel).** Função curta não segura canal de
   controle, worker de teste em background nem monitor de idle. Solução que
   mantém serverless: **o daemon dentro do Codespace faz o trabalho de fundo**
   (roda testes, escreve resultado via callback assinado no Supremo); o idle-stop
   roda por **cron agendado** batendo na API de Codespaces. (Alternativa: um
   worker persistente separado — mais infra.)

3. **Preview privado não embute em iframe cross-origin.** Porta encaminhada
   privada do Codespaces exige auth do GitHub (cookie) → CSP/cookies barram o
   iframe. Fallback: abrir o preview **autenticado externamente**, com a
   arquitetura pronta para um **proxy seguro** do Supremo depois. Porta NUNCA
   pública por padrão.

## Dependência externa (só você pode fazer)

A **GitHub App** precisa da permissão **Codespaces (read & write)**, e a conta/org
precisa de Codespaces habilitado (tem **custo por hora de compute + storage**).
Sem isso não dá para criar/testar Codespaces. Todo o código é preparado antes.

## Modelo (Fase A — feito)

- `project_runtimes` (1 por projeto, `UNIQUE(project_id)`), `validation_runs`
  (testes em background), `agent_sessions` (handoff). RLS owner-only.
- `lib/runtime/types.ts`: `ProjectRuntime`, `RuntimeProvider` (adapter),
  `RuntimeError` tipado.

## Fases

- **A — feito**: schema + abstração (não destrutivo).
- **B** (precisa da permissão): `CodespaceService` (lifecycle via REST), resolução
  `project_id → runtime` server-side com isolamento + testes.
- **C**: lifecycle (start on open, idle-stop por cron, retry, detectar deleção externa).
- **D**: `.devcontainer` + daemon do runtime (dev server, HMR, aplicar edições) + PreviewService (privado + fallback externo).
- **E**: roteamento do MCP pelo runtime (tarefa → daemon → resumo).
- **F**: validação em background (debounce 20–30s, stale, resultado resumido).
- **G**: continuidade de agente (`.supremo/` + `agent_sessions`).
- **H**: UI (status runtime/preview/validação + Retry).
- **I**: hardening + testes.

## Custo/viabilidade (honesto)

Codespaces cobra por hora de compute + storage por projeto. Um Codespace por
projeto muda o modelo de custo (hoje: Vercel free + minutos do Actions). Idle-stop
reduz, mas a escala tem custo real. A abstração `RuntimeProvider` permite trocar
o provedor (Fly, container, sandbox) sem reescrever o resto, se o custo pesar.
