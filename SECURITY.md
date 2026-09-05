# SECURITY.md — Políticas de Segurança do Supremo

## Princípios Fundamentais

### 1. Zero Trust no Client
O client (browser) é considerado não confiável. Toda lógica sensível ocorre no servidor:
- Verificações de autenticação: `middleware.ts` + Server Actions
- Verificações de autorização: sempre `auth.uid()` no banco via RLS
- Validação de inputs: Zod no servidor, nunca apenas no client

### 2. Defense in Depth
Múltiplas camadas de proteção:
- **Camada 1:** Middleware (auth check, rate limiting)
- **Camada 2:** Server Action (validação Zod, permissão)
- **Camada 3:** Banco de Dados (RLS policy)

### 3. Principle of Least Privilege
- Tokens de GitHub/Supabase com escopos mínimos necessários
- Service roles do Supabase APENAS no servidor (nunca expostos)
- API keys de terceiros NUNCA no client bundle

## Tokens e Secrets

### Armazenamento
- Tokens OAuth de GitHub e Supabase: criptografados com AES-256-GCM
- Chave de criptografia: `ENCRYPTION_KEY` (64 hex chars) — apenas no servidor
- NUNCA armazenar tokens em localStorage, cookies sem httpOnly, ou sessionStorage

### Rotação
- Refresh tokens renovados automaticamente antes de expirar
- Tokens revogados imediatamente no logout

## Supabase RLS — Padrões

### Template obrigatório para toda tabela:
```sql
-- 1. Habilitar RLS
ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;

-- 2. Isolar por usuário
CREATE POLICY "{table}_user_isolation" ON {table}
  FOR ALL USING (auth.uid() = user_id);

-- 3. Admin via JWT claims (nunca via coluna)
CREATE POLICY "{table}_admin_access" ON {table}
  FOR ALL USING (
    (auth.jwt() ->> 'user_metadata')::jsonb ->> 'role' = 'admin'
  );
```

### Anti-patterns proibidos:
```sql
-- ❌ NUNCA: desabilitar RLS
ALTER TABLE sensitive_data DISABLE ROW LEVEL SECURITY;

-- ❌ NUNCA: policy que aceita qualquer autenticado sem isolamento
CREATE POLICY "all_authenticated" ON table FOR ALL USING (auth.uid() IS NOT NULL);

-- ❌ NUNCA: verificar role via coluna escalável
CREATE POLICY "admin" ON table FOR ALL USING (is_admin = true); -- coluna pode ser manipulada
```

## Headers de Segurança (next.config.ts)

```typescript
const securityHeaders = [
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' 'unsafe-inline'", // unsafe-eval necessário para Next.js dev
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data: https:",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    ].join('; '),
  },
];
```

## Rate Limiting

Os limites efetivos são definidos no código das rotas e do middleware.
O limitador em memória vale por instância; não equivale a uma quota global
compartilhada entre servidores. Revise esse controle antes de escalar horizontalmente.

## Vulnerabilidades — Checklist de Review

Antes de todo commit, verificar:
- [ ] Nenhum secret hardcoded
- [ ] Nenhuma validação apenas no client
- [ ] Nenhum `dangerouslySetInnerHTML` sem sanitização
- [ ] Nenhuma query SQL construída com string concatenation
- [ ] Todos os inputs validados com Zod no servidor
- [ ] RLS ativo em todas as tabelas novas
- [ ] Logs não contêm dados sensíveis (passwords, tokens, PII)
- [ ] Erros retornados ao client não expõem detalhes internos
