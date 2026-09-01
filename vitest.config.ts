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
      // Medimos o código que carrega lógica de decisão. Adaptadores de I/O
      // ficam de fora porque um teste unitário neles exercita o mock, não o
      // código — a cobertura real deles vem dos testes de integração e do E2E.
      include: ['src/lib/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        'src/lib/supabase/**',       // fábricas finas sobre o SDK
        'src/lib/mcp/github.ts',     // cliente HTTP da API do GitHub
        'src/lib/mcp/repository.ts', // acesso ao Postgres
        'src/lib/auth.ts',           // depende de cookies de requisição
        'src/lib/mcp/server.ts',     // registro de ferramentas de I/O;
                                     // a parte pura (slugToBranch) tem teste
        // Adaptadores de I/O do provisioning/bootstrap v2: falam com GitHub API,
        // Supabase Management API e Postgres. Cobertura real vem do E2E (repo +
        // projeto Supabase reais); a LÓGICA pura vive testada à parte (engine,
        // capabilities, codes, command, buildAppJwt, verify-classifier, harness).
        'src/lib/provisioning/provision.ts', // core: GitHub+Supabase+DB
        'src/lib/bootstrap/config.ts',       // resolve credenciais/env
        'src/lib/bootstrap/git-clone-token.ts', // installation token (API do App)
      ],
      // Threshold que falha o build. Cobertura reportada e não exigida
      // não é gate — é decoração.
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
      },
    },
  },
})
