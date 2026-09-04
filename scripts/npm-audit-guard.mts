#!/usr/bin/env -S npx tsx
/**
 * SUPREMO — Guarda de robustez do `npm audit --audit-level=high` na CI
 * (job "Vulnerabilidades", `.github/workflows/ci.yml`).
 *
 * Motivação e classificação completa: `src/lib/ci/npm-audit-classify.ts`.
 * Resumo: vulnerabilidade real ou erro genuíno do npm falham IMEDIATAMENTE,
 * sem retry. Só falha transitória de infraestrutura/rede do registry
 * (429/5xx, timeout, ECONNRESET/ETIMEDOUT, DNS, ou o 400 "Invalid package
 * tree" documentado no classificador) ganha até `MAX_ATTEMPTS` tentativas
 * com um backoff pequeno. Esgotadas as tentativas, a CI continua vermelha —
 * nunca ignora, nunca faz bypass.
 *
 * Uso: npx tsx scripts/npm-audit-guard.mts
 */
import { spawnSync } from 'node:child_process'
import { classifyNpmAuditFailure } from '../src/lib/ci/npm-audit-classify'

export const MAX_ATTEMPTS = 3
const DEFAULT_BACKOFF_MS = [2_000, 5_000]

/**
 * Backoff entre tentativas — configurável via env só para os testes (que
 * não podem gastar segundos reais de espera); a CI usa sempre o default.
 */
function backoffSchedule(): number[] {
  const raw = process.env.SUPREMO_NPM_AUDIT_BACKOFF_MS
  if (!raw) return DEFAULT_BACKOFF_MS

  const parsed = raw
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0)

  return parsed.length > 0 ? parsed : DEFAULT_BACKOFF_MS
}

function runAuditOnce(): { status: number; output: string } {
  const result = spawnSync('npm', ['audit', '--audit-level=high'], {
    encoding: 'utf8',
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  // spawnSync deixa status null se o processo morreu por sinal — trata como
  // falha (nunca finge sucesso).
  return { status: result.status ?? 1, output }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  const backoff = backoffSchedule()

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { status, output } = runAuditOnce()
    process.stdout.write(output)

    if (status === 0) {
      if (attempt > 1) {
        console.log(
          `\n✓ npm audit --audit-level=high passou na tentativa ${attempt}/${MAX_ATTEMPTS} (falha anterior era instabilidade transitória do registry).`,
        )
      }
      return
    }

    const classification = classifyNpmAuditFailure(output)

    if (classification === 'vulnerability') {
      console.error(
        '\n✗ npm audit encontrou vulnerabilidade high/critical — falha imediata, sem retry.',
      )
      process.exit(status)
    }

    if (classification === 'error') {
      console.error(
        '\n✗ npm audit falhou (erro real do npm, não é instabilidade do registry) — falha imediata, sem retry.',
      )
      process.exit(status)
    }

    if (attempt === MAX_ATTEMPTS) {
      console.error(
        `\n✗ npm audit falhou por instabilidade transitória do registry em ${MAX_ATTEMPTS}/${MAX_ATTEMPTS} tentativas — CI continua vermelha.`,
      )
      process.exit(status)
    }

    const wait =
      backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? DEFAULT_BACKOFF_MS[0] ?? 2_000
    console.warn(
      `\n⚠ npm audit falhou por instabilidade transitória do registry (tentativa ${attempt}/${MAX_ATTEMPTS}) — nova tentativa em ${wait}ms…`,
    )
    await sleep(wait)
  }
}

main()
