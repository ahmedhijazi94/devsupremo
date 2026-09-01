/**
 * Motor de provisioning por passos — idempotente e retomável.
 *
 * A máquina é: draft → provisioning → scaffolding → validating → ready|failed.
 * Cada passo declara o ESTADO em que roda e produz saídas (IDs externos) que são
 * persistidas. No retry, passos já concluídos são pulados (reusando as saídas),
 * e o motor continua do primeiro pendente — sem recriar recurso externo e sem
 * tratar "already exists" como fluxo normal.
 *
 * Passo pode persistir saída PARCIAL no meio (via `persist`): ex., gravar o ref
 * do Supabase assim que o projeto é criado, antes de migrar. Se falhar depois, o
 * retry acha o ref já persistido no ctx e reusa em vez de criar de novo.
 *
 * `ready` só é marcado depois que TODOS os passos (incluindo o de `validating`)
 * concluíram — nunca sem validação.
 */

export const PROVISIONING_STATES = [
  'draft',
  'provisioning',
  'scaffolding',
  'validating',
  'ready',
  'failed',
] as const
export type ProvisioningState = (typeof PROVISIONING_STATES)[number]

/** Estado em que um passo roda (nunca terminal). */
export type StepState = 'provisioning' | 'scaffolding' | 'validating'

export interface StepRecord {
  status: 'pending' | 'done'
  output?: Record<string, unknown>
}
export type ProvisioningSteps = Record<string, StepRecord>

export type PersistPartial = (partial: Record<string, unknown>) => Promise<void>

export interface StepDef<Ctx extends Record<string, unknown>> {
  name: string
  state: StepState
  /**
   * Executa o passo. Recebe o ctx acumulado (saídas persistidas dos passos
   * anteriores, e a saída parcial deste passo num retry). `persist` grava saída
   * parcial imediatamente (IDs externos antes de avançar). Retorna a saída final
   * do passo. Só é chamado se o passo NÃO estiver concluído.
   */
  run(ctx: Ctx, persist: PersistPartial): Promise<Record<string, unknown>>
}

export interface EngineHooks {
  /** Muda o provisioning_state (persistido). */
  setState(state: StepState): Promise<void>
  /** Persiste o registro de um passo (status + saída acumulada). */
  persistStep(name: string, record: StepRecord): Promise<void>
  /** Finaliza: provisioning_state = 'ready' (+ metadata). Só após todos os passos. */
  markReady(): Promise<void>
  /** provisioning_state = 'failed' + erro. */
  markFailed(step: string, error: string): Promise<void>
}

export interface EngineResult {
  ok: boolean
  error?: string
  ran: string[]
  skipped: string[]
}

export async function runProvisioning<Ctx extends Record<string, unknown>>(
  steps: StepDef<Ctx>[],
  persisted: ProvisioningSteps,
  hooks: EngineHooks,
  baseCtx: Ctx,
): Promise<EngineResult> {
  const ran: string[] = []
  const skipped: string[] = []
  let ctx = { ...baseCtx } as Ctx & Record<string, unknown>

  for (const step of steps) {
    const rec = persisted[step.name]

    // Carrega saída persistida (de passo concluído OU parcial de pendente) no
    // ctx — é isso que permite reusar IDs externos sem recriar.
    if (rec?.output) ctx = { ...ctx, ...rec.output }

    if (rec?.status === 'done') {
      skipped.push(step.name)
      continue
    }

    await hooks.setState(step.state)

    // Acumulador da saída deste passo (parte do que já foi persistido + novidades).
    let acc: Record<string, unknown> = { ...(rec?.output ?? {}) }
    const persist: PersistPartial = async (partial) => {
      acc = { ...acc, ...partial }
      ctx = { ...ctx, ...partial }
      await hooks.persistStep(step.name, { status: 'pending', output: acc })
    }

    try {
      const output = await step.run(ctx, persist)
      acc = { ...acc, ...output }
      ctx = { ...ctx, ...output }
      await hooks.persistStep(step.name, { status: 'done', output: acc })
      ran.push(step.name)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await hooks.markFailed(step.name, message)
      return { ok: false, error: message, ran, skipped }
    }
  }

  await hooks.markReady()
  return { ok: true, ran, skipped }
}
