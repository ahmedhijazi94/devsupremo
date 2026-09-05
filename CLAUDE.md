# CLAUDE.md — Regras para agentes locais

Leia AGENTS.md primeiro. Este arquivo complementa com regras específicas de comportamento.

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

O agente trabalha diretamente nos arquivos locais. Leia AGENTS.md e SECURITY.md.
No projeto gerado, siga seus scripts de retomada e checkpoint. No repositório
Supremo, use os comandos de desenvolvimento e verificação do package.json.
Preserve um preview saudável. Publicação e CI seguem em background; não faça
o usuário esperar o CI para continuar a próxima alteração. Só promova para
produção com as verificações exigidas e o ambiente de destino identificado.
