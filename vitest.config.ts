import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/lib/**/*.ts'],
      // ── POLÍTICA DE COBERTURA (para futuras contribuições) ──────────────────
      // O threshold de 85% mede LÓGICA DE DOMÍNIO: decisão, transformação, state
      // machine, validação, geração, invariantes de segurança e regras
      // arquiteturais — tudo testável sem mockar sistemas externos. Ex.:
      // provisioning/engine, capabilities, bootstrap/codes (device flow),
      // bootstrap/command, git-clone-token (JWT do App), verify-classifier,
      // templates/* (generator + rls-tests), mcp/sql-guard, crypto, oauth-state,
      // *-token (refresh), mcp/tokens (identidade).
      //
      // Ficam FORA da métrica apenas ADAPTERS DE I/O: arquivos cujo papel é
      // falar com um sistema externo (API, Postgres, filesystem, cookies). Um
      // teste unitário neles exercita o mock, não o código — a cobertura real
      // vem dos testes de integração e do E2E. Ao excluir um arquivo aqui ele
      // precisa ser INEQUIVOCAMENTE um adapter; NUNCA se exclui código com
      // lógica de segurança/provisioning/domínio (esse recebe teste, não
      // exclusão). Se um arquivo mistura os dois, separe o I/O (ex.: o store
      // Supabase saiu de bootstrap/codes.ts para bootstrap/supabase-store.ts).
      exclude: [
        '**/*.test.ts',
        // Clientes de API externa e acesso a banco
        'src/lib/mcp/github.ts', // cliente HTTP da API do GitHub
        'src/lib/mcp/repository.ts', // acesso ao Postgres (dados de projeto)
        'src/lib/mcp/server.ts', // registro de ferramentas de I/O do MCP
        'src/lib/vercel.ts', // cliente da API da Vercel
        'src/lib/preview.ts', // Management API (anon key) + preview Vercel
        'src/lib/account-health.ts', // pinga GitHub/Supabase/Vercel p/ validar token
        'src/lib/db-introspect.ts', // introspecção via Postgres
        'src/lib/provisioning/provision.ts', // provisioning: GitHub+Supabase+DB (E2E)
        'src/lib/bootstrap/config.ts', // resolve credenciais/env + App token
        'src/lib/bootstrap/supabase-store.ts', // store do device flow sobre Postgres
        'src/lib/runtime/companion-identity.ts', // Admin API do Supabase
        'src/lib/runtime/realtime-broadcast.ts', // broadcast HTTP do Realtime
        // Contexto de requisição / factories finas / tipos
        'src/lib/auth.ts', // depende de cookies de requisição
        'src/lib/supabase/**', // fábricas finas sobre o SDK
        'src/lib/runtime/types.ts', // só tipos/constantes
      ],
      // Threshold que falha o build. Cobertura reportada e não exigida não é
      // gate — é decoração.
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
      },
    },
  },
})
