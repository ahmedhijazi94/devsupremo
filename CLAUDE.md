# CLAUDE.md — Regras para Claude e todos os MCPs

Leia agents.md primeiro. Este arquivo complementa com regras específicas de comportamento.

## Comportamento Obrigatório

### Ao receber qualquer prompt de funcionalidade:
1. **Leia o estado atual** do branch antes de qualquer coisa
2. **Planeje** quais arquivos serão criados/modificados
3. **Implemente** com arquitetura limpa e segurança máxima
4. **Escreva testes** junto com o código (nunca depois)
5. **Nunca assuma** que algo já está implementado — verifique

### Sobre Banco de Dados:
- Decida o schema completo sozinho a partir da descrição da funcionalidade
- Sempre inclua: foreign keys, índices, RLS policies, triggers de `updated_at`
- Nunca pergunte "qual tabela devo criar?" — decida você mesmo com a melhor arquitetura

### Sobre Segurança:
- Se detectar validação no client → refatore para server
- Se detectar secret exposto → bloqueie e corrija antes de continuar
- Se detectar escalação de role via client → bloqueie imediatamente
- Sempre use `auth.uid()` no RLS, nunca parâmetros da URL ou body

### Sobre Commits:
- Mensagem semântica: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`
- Descrição clara do que mudou e por quê
- Um commit por funcionalidade, nunca misture features

### O que NUNCA fazer:
- `any` no TypeScript
- `console.log` em produção (use logger estruturado)
- Lógica de negócio em componentes React
- Mutations diretas ao Supabase no client (use Server Actions)
- `.env` commitado (apenas `.env.example`)
- Secrets no código (apenas variáveis de ambiente)
- Desabilitar RLS "temporariamente"
- Confiar em `user_id` vindo do client body (use sempre `auth.uid()`)

## Fluxo de Trabalho no Supremo

Ferramentas reais do MCP (fonte da verdade: `src/lib/mcp/server.ts`):
`get_project_context`, `list_projects`, `switch_project`, `read_file`,
`list_files`, `propose_changes`, `get_checks`, `wait_for_checks`,
`get_failed_logs`, `retrigger_ci`, `merge_when_green`, `get_preview_errors`,
`execute_sql`, `apply_data_change`, `apply_migration`, `sync_template`,
`request_secret`.

Quando ativado via MCP do Supremo:
1. `get_project_context` — projeto ativo, regras (agents.md/CLAUDE.md/SECURITY.md)
   e PRs em andamento a retomar, tudo numa chamada
2. Planeje a mudança inteira e implemente no MENOR número de ciclos
3. `propose_changes` (ou `apply_migration` com `files` para migration+código no
   mesmo PR); dado puro é `apply_data_change`, sem gates
4. `wait_for_checks`; se `ciStarted:false`, `retrigger_ci` uma vez
5. `merge_when_green` fecha o ciclo (recusa sem tudo verde)
6. Integração externa que precisa de chave: `request_secret`, nunca no código
7. Se falhar: `get_failed_logs`, corrija, proponha de novo (máx 3x)
