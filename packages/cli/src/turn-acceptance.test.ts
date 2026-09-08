import { describe, expect, it } from 'vitest'
import { acceptanceContractSchema } from './turn-acceptance'
const contract = { version: 1, criteria: [{ id: 'ownership', description: 'A cria; B não lê/altera/exclui; A mantém acesso', requiredChecks: ['cross-user'] }],
  checks: [{ name: 'cross-user', type: 'rls', files: ['tests/tickets.rls.test.ts'] }] }
describe('behavior acceptance contract', () => {
  it('representa prova de isolamento ligada ao comportamento', () => { expect(acceptanceContractSchema.parse(contract).criteria[0]?.requiredChecks).toEqual(['cross-user']) })
  it.each(['lib/tickets/schema.test.ts', 'app/app/actions.test.ts', 'app/login/actions.test.ts',
    'components/app-shell.test.tsx', 'src/app/(protected)/[id]/page.spec.tsx', 'tests/auth.test.mts', 'e2e/login.spec.ts'])('aceita prova colocada junto ao código do scaffold: %s', (file) => {
    expect(acceptanceContractSchema.safeParse({ ...contract, checks: [{ ...contract.checks[0], type: 'unit', files: [file] }] }).success).toBe(true)
  })
  it('permite nomear as provas nativas Supabase somente com o gate RLS', () => {
    const check = { ...contract.checks[0], files: ['supabase/tickets.rls.test.ts'] }
    expect(acceptanceContractSchema.safeParse({ ...contract, checks: [check] }).success).toBe(true)
    expect(acceptanceContractSchema.safeParse({ ...contract, checks: [{ ...check, type: 'unit' }] }).success).toBe(false)
    expect(acceptanceContractSchema.safeParse({ ...contract, checks: [{ ...check, files: ['supabase/migrations/applied.test.ts'] }] }).success).toBe(false)
  })
  it.each(['../other/test.ts', '/tmp/test.spec.ts', 'tests/../../outside.test.ts', 'tests/test.txt',
    'app/../lib/schema.test.ts', 'app/./actions.test.ts', 'app//actions.test.ts', 'app\\actions.test.ts',
    'app/actions.test.ts\n', 'app/\u0000actions.test.ts', 'src/node_modules/injected.test.ts', 'src/.git/config.test.ts',
    'src/.supremo/injected.test.ts', 'node_modules/lib/test.test.ts', '--config=other.test.ts', 'C:/app/actions.test.ts'])('rejeita caminho não executável/fora do projeto %s', (file) => {
    expect(acceptanceContractSchema.safeParse({ ...contract, checks: [{ ...contract.checks[0], files: [file] }] }).success).toBe(false)
  })
  it('recusa critério sem check ou check duplicado', () => {
    expect(acceptanceContractSchema.safeParse({ ...contract, checks: [] }).success).toBe(false)
    expect(acceptanceContractSchema.safeParse({ ...contract, checks: [...contract.checks, ...contract.checks] }).success).toBe(false)
    expect(acceptanceContractSchema.safeParse({ ...contract, checks: [{ ...contract.checks[0], name: 'different' }] }).success).toBe(false)
  })
})
