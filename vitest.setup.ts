import { vi } from 'vitest'

// Chave determinística só para os testes. Nunca usada fora deles.
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  '0'.repeat(64)
// Server-only modules are exercised in tests; Next enforces this boundary in production builds.
vi.mock('server-only', () => ({}))
