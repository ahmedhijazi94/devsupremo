# Runtime de desenvolvimento por projeto — Companion Local

Arquitetura ALVO (aprovada, fixa). Objetivo: dev tão rápido quanto o Lovable,
seguro como o Supremo, **custo de infra ~zero**. O preview de desenvolvimento
roda na **máquina do dev** (Next.js real + HMR), orquestrado pelo Supremo web.

## Arquitetura ANTES (auditada)

Next.js 16 na **Vercel (serverless)** + Supabase (RLS). O MCP não executa
código: escreve via **GitHub API** e SQL via **Supabase Management API**. O
motor de build/preview era **GitHub Actions** (gates) + **Vercel** (deploy →
iframe). Cada ciclo = round-trips + fila do Actions + build da Vercel = minutos.

## Arquitetura DEPOIS (alvo)

```
                    INTERNET
   ┌──────────────────────────────────────────┐
   │            SUPREMO WEB                     │  orquestra (não roda seu app)
   │      Vercel + Supabase + MCP               │
   └──────────────────────┬────────────────────┘
                          │ canal seguro (companion disca pra fora)
                          ▼
              ┌───────────────────────┐        ┌──────────────┐
              │  SUPREMO COMPANION     │◄─clone─│    GITHUB     │ fonte oficial
              │    na máquina do dev   │──push─►│  (assíncrono) │
              └───────────┬───────────┘        └──────────────┘
                          │
              ┌───────────┴───────────┐
        projeto real Next.js     testes em background
              │                   (local, grátis)
         npm run dev                  │
              │                  resultado ─► Supremo (Supabase)
              ▼
         localhost:PORT
              ▼  (o navegador do dev acessa localhost direto)
         PREVIEW REAL ──► exibido na tela do Supremo
```

**GitHub fora do caminho crítico da edição.** A edição do agente vai DIRETO ao
filesystem local (`apply_edits`) → HMR → preview imediato. Clone/pull é só
bootstrap; commit/push é assíncrono (`git_sync`).

## Fluxo do milestone: "cliquei no projeto → preview Next real abriu"

1. **Uma vez por máquina**: `npx supremo-runtime` + login → o companion fica
   rodando e disca pro Supremo (canal autenticado, sem abrir porta).
2. Usuário abre o Projeto A no Supremo web → botão **Preview local**.
3. Supremo manda `start_project { projectId, repoFullName, branch, cloneToken }`
   (cloneToken de curta duração; nunca token de admin).
4. Companion resolve o **workspace isolado** `base/<userId>/<projectId>`:
   - não existe → `git clone` (bootstrap). Existe → `git pull`.
5. Detecta o gerenciador (npm/pnpm/yarn pelo lockfile) → instala deps →
   emite `runtime_status: preparing` (logs throttled via `log`).
6. Sobe o dev server (`npm run dev`) na porta preferida do projeto →
   `runtime_status: starting`.
7. Detecta o dev pronto → `preview_ready { url: http://localhost:PORT }`.
8. Supremo web exibe o preview (embute; fallback: abre em aba — ver "display").
9. Agente altera código → `apply_edits` escreve DIRETO no filesystem local →
   Next **HMR** atualiza o preview em ms. Sem GitHub, sem Vercel, sem CI no meio.
10. Em paralelo/assíncrono: `run_validation` (testes locais em background) e
    `git_sync` (commit/push) — nenhum bloqueia o agente/MCP.

## Protocolo (fonte da verdade: `src/lib/runtime/protocol.ts`)

Comandos (Supremo→companion): `start_project`, `stop_project`, `apply_edits`,
`run_validation`, `git_sync`. Eventos (companion→Supremo): `runtime_status`,
`preview_ready`, `log`, `validation_result`, `error`. Tudo validado por zod dos
dois lados; nenhuma mensagem carrega token de admin/service_role.

## Transporte (canal seguro)

Vercel serverless não hospeda servidor WebSocket. Escolha: **Supabase Realtime**
(já está na stack, custo zero, conexão persistente autenticada). Companion e web
entram num canal por projeto; comandos descem, eventos sobem. (Fase seguinte.)

## Segurança (mesmo modelo + a superfície nova)

Inalterado: RLS, isolamento multi-tenant, gates, secrets, ownership, auditoria.
Novo: o **companion**. Regras — token **escopado, nunca admin**; age só no
projeto do comando (project_id resolvido no servidor, nunca do cliente);
**workspace isolado por user+project** (provado em teste: A não escreve em B, sem
traversal — `safeEditPath`); nunca recebe service_role/secrets de servidor.

## Display do preview (a única nuance)

`https` (Supremo na nuvem) embutir `http://localhost` é "mixed content": Chrome
costuma liberar loopback; Safari é rígido. Fallback 100%: abrir o preview numa
aba (localhost direto). Evolução: https-localhost (mkcert) ou túnel pra
compartilhar com cliente remoto.

## Fases

- **A — feito**: schema (`project_runtimes`, `validation_runs`, `agent_sessions`) +
  abstração (`RuntimeProvider`, `PreviewKind`). Não destrutivo.
- **B — feito (fundação)**: protocolo (`protocol.ts`) + lógica pura do workspace
  (`workspace.ts`: isolamento, detecção de PM, `safeEditPath`) + testes.
- **C**: companion CLI (conecta via Realtime, `start_project` real: clone/install/
  dev, `preview_ready`).
- **D**: Supremo web — botão Preview local + exibição + estados (Loading/Compiling/
  Ready/Error), com Vercel como fallback (preservado).
- **E**: `apply_edits` direto (edição do agente → HMR) e roteio do MCP.
- **F**: `run_validation` local em background (debounce 20–30s, stale, resumo).
- **G**: `git_sync` assíncrono + handoff (`agent_sessions`, `.supremo/`).
- **H/I**: UX, concorrência/locks, fallback, hardening.

## O que fica do que já existe

GitHub (versionamento), Supabase (banco + Realtime), Vercel (hospeda o Supremo e
segue como **preview de fallback** e deploy de produção). Fase A/B são aditivas.
