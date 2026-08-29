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

Quando ativado via MCP do Supremo:
1. Chame `get_active_project()` para saber o projeto ativo
2. Chame `get_project_context()` para ler agents.md e regras
3. Chame `get_branch_state()` para entender o estado atual
4. Implemente a funcionalidade
5. Chame `apply_code_diff(diff)` para aplicar as mudanças
6. Chame `run_test_pipeline()` e aguarde resultado
7. Se testes passarem → `commit_and_deploy(msg)`
8. Se falhar → corrija e tente novamente (máx 3x)
