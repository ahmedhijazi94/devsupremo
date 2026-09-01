import { describe, expect, it, vi } from 'vitest'
import {
  runProvisioning,
  type EngineHooks,
  type ProvisioningSteps,
  type StepDef,
} from './engine'

type Ctx = Record<string, unknown>

function recorder() {
  const calls = {
    states: [] as string[],
    persisted: {} as ProvisioningSteps,
    ready: 0,
    failed: [] as string[],
  }
  const hooks: EngineHooks = {
    setState: async (s) => {
      calls.states.push(s)
    },
    persistStep: async (n, r) => {
      calls.persisted[n] = r
    },
    markReady: async () => {
      calls.ready++
    },
    markFailed: async (n, e) => {
      calls.failed.push(`${n}:${e}`)
    },
  }
  return { hooks, calls }
}

/** Passo que registra se rodou e devolve uma saída fixa. */
function step(
  name: string,
  state: 'provisioning' | 'scaffolding' | 'validating',
  spy: ReturnType<typeof vi.fn>,
  output: Record<string, unknown> = {},
): StepDef<Ctx> {
  return {
    name,
    state,
    run: async (ctx, persist) => spy(ctx, persist) ?? output,
  }
}

const done = (output: Record<string, unknown> = {}) =>
  ({ status: 'done', output }) as const

describe('resume idempotente por passo', () => {
  it('falha após criação do repo → retry NÃO cria segundo repo', async () => {
    const github = vi.fn()
    const supabase = vi.fn()
    const { hooks, calls } = recorder()
    const persisted: ProvisioningSteps = { github: done({ repoId: 1 }) }

    const res = await runProvisioning(
      [
        step('github', 'provisioning', github),
        step('supabase', 'provisioning', supabase),
      ],
      persisted,
      hooks,
      {},
    )

    expect(github).not.toHaveBeenCalled() // repo não recriado
    expect(res.skipped).toContain('github')
    expect(res.ran).toContain('supabase')
    // o ID externo persistido foi carregado no ctx do próximo passo
    expect(supabase.mock.calls[0]![0]).toMatchObject({ repoId: 1 })
    expect(calls.ready).toBe(1)
  })

  it('falha após Supabase → retry reutiliza o mesmo projeto', async () => {
    const supabase = vi.fn()
    const scaffold = vi.fn()
    const { hooks } = recorder()
    const persisted: ProvisioningSteps = {
      github: done({ repoFullName: 'a/b' }),
      supabase: done({ supabaseProjectRef: 'ref1' }),
    }

    const res = await runProvisioning(
      [
        step('github', 'provisioning', vi.fn()),
        step('supabase', 'provisioning', supabase),
        step('scaffold', 'scaffolding', scaffold),
      ],
      persisted,
      hooks,
      {},
    )

    expect(supabase).not.toHaveBeenCalled() // projeto não recriado
    expect(scaffold.mock.calls[0]![0]).toMatchObject({
      repoFullName: 'a/b',
      supabaseProjectRef: 'ref1',
    })
    expect(res.ran).toEqual(['scaffold'])
  })

  it('falha durante scaffold → continua do scaffold', async () => {
    const github = vi.fn()
    const scaffold = vi.fn()
    const { hooks } = recorder()
    const persisted: ProvisioningSteps = {
      github: done(),
      supabase: done(),
    }

    const res = await runProvisioning(
      [
        step('github', 'provisioning', github),
        step('supabase', 'provisioning', vi.fn()),
        step('scaffold', 'scaffolding', scaffold),
      ],
      persisted,
      hooks,
      {},
    )

    expect(github).not.toHaveBeenCalled()
    expect(scaffold).toHaveBeenCalledOnce()
    expect(res.ran).toEqual(['scaffold'])
  })

  it('falha durante validating → retry repete só a validação', async () => {
    const validation = vi.fn()
    const { hooks, calls } = recorder()
    const persisted: ProvisioningSteps = {
      github: done(),
      supabase: done(),
      scaffold: done(),
      protection: done(),
    }

    const res = await runProvisioning(
      [
        step('github', 'provisioning', vi.fn()),
        step('supabase', 'provisioning', vi.fn()),
        step('scaffold', 'scaffolding', vi.fn()),
        step('protection', 'scaffolding', vi.fn()),
        step('validation', 'validating', validation),
      ],
      persisted,
      hooks,
      {},
    )

    expect(validation).toHaveBeenCalledOnce()
    expect(res.ran).toEqual(['validation'])
    expect(calls.states).toEqual(['validating'])
    expect(calls.ready).toBe(1)
  })

  it('retry repetido é idempotente (tudo done → nada roda, ready estável)', async () => {
    const spies = [vi.fn(), vi.fn()]
    const { hooks, calls } = recorder()
    const persisted: ProvisioningSteps = { a: done(), b: done() }
    const steps = [
      step('a', 'provisioning', spies[0]!),
      step('b', 'validating', spies[1]!),
    ]

    await runProvisioning(steps, persisted, hooks, {})
    await runProvisioning(steps, persisted, hooks, {})

    expect(spies[0]).not.toHaveBeenCalled()
    expect(spies[1]).not.toHaveBeenCalled()
    expect(calls.ready).toBe(2) // idempotente: ready toda vez, nada recriado
  })

  it('ready NUNCA ocorre sem validating bem-sucedido', async () => {
    const validation = vi.fn(() => {
      throw new Error('baseline falhou')
    })
    const { hooks, calls } = recorder()

    const res = await runProvisioning(
      [
        step('scaffold', 'scaffolding', vi.fn()),
        step('validation', 'validating', validation),
      ],
      {},
      hooks,
      {},
    )

    expect(res.ok).toBe(false)
    expect(calls.ready).toBe(0) // não marcou ready
    expect(calls.failed).toEqual(['validation:baseline falhou'])
  })
})

describe('persistência parcial de ID externo', () => {
  it('persiste ID no meio do passo e o retry reutiliza sem recriar', async () => {
    // 1ª tentativa: cria o "projeto" (persist ref) e depois FALHA.
    let created = 0
    const supabaseStep: StepDef<Ctx> = {
      name: 'supabase',
      state: 'provisioning',
      run: async (ctx, persist) => {
        if (!ctx.ref) {
          created++
          await persist({ ref: 'ref-xyz' }) // grava ID assim que cria
          throw new Error('caiu depois de criar')
        }
        return { migrated: true }
      },
    }

    const rec = recorder()
    const steps = [supabaseStep]

    const first = await runProvisioning(steps, {}, rec.hooks, {})
    expect(first.ok).toBe(false)
    expect(created).toBe(1)
    // o ref ficou persistido como pendente
    expect(rec.calls.persisted.supabase).toMatchObject({
      status: 'pending',
      output: { ref: 'ref-xyz' },
    })

    // 2ª tentativa: parte do estado persistido (ref presente) → não recria.
    const rec2 = recorder()
    const second = await runProvisioning(
      steps,
      { supabase: { status: 'pending', output: { ref: 'ref-xyz' } } },
      rec2.hooks,
      {},
    )
    expect(second.ok).toBe(true)
    expect(created).toBe(1) // NÃO criou de novo
    expect(rec2.calls.persisted.supabase).toMatchObject({ status: 'done' })
    expect(rec2.calls.ready).toBe(1)
  })
})
