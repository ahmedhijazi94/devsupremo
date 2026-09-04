import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, it, expect } from 'vitest'

/**
 * Execução REAL do `scripts/npm-audit-guard.mts` (não string matching) —
 * prova o comportamento fim-a-fim que os testes puros de
 * `classifyNpmAuditFailure` não alcançam sozinhos: o loop de retry com
 * backoff, o corte imediato (sem gastar tentativa) em vulnerabilidade/erro
 * real, e o esgotamento das tentativas continuando vermelho.
 *
 * `npm` é um shim no PATH — nunca toca o registry de verdade. O shim é
 * stateful: cada chamada incrementa um contador em arquivo e responde de
 * acordo com a lista de comportamentos configurada pelo teste, provando
 * quantas vezes o guard realmente invocou `npm audit`.
 */

const ROOT = process.cwd()
const TSX_BIN = join(ROOT, 'node_modules', '.bin', 'tsx')
const GUARD_SCRIPT = join(ROOT, 'scripts', 'npm-audit-guard.mts')

interface ShimCall {
  exitCode: number
  output: string
}

/** Shim `npm` stateful: a N-ésima chamada usa `calls[N-1]` (repete a última se exceder). */
function writeStatefulNpmShim(binDir: string, calls: ShimCall[]): { countFile: string } {
  const file = join(binDir, 'npm')
  const countFile = join(binDir, '.call-count')
  writeFileSync(countFile, '0', 'utf8')

  const branches = calls
    .map((call, i) => {
      const marker = `NPM_SHIM_${i + 1}`
      return [
        `if [ "$COUNT" = "${i + 1}" ]; then`,
        `  cat <<'${marker}'`,
        call.output,
        marker,
        `  exit ${call.exitCode}`,
        `fi`,
      ].join('\n')
    })
    .join('\n')

  const last = calls[calls.length - 1] ?? { exitCode: 1, output: '' }
  const script = `#!/bin/sh
COUNT_FILE="${countFile}"
COUNT=$(cat "$COUNT_FILE")
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNT_FILE"
${branches}
cat <<'NPM_SHIM_LAST'
${last.output}
NPM_SHIM_LAST
exit ${last.exitCode}
`
  writeFileSync(file, script, 'utf8')
  chmodSync(file, 0o755)
  return { countFile }
}

function setup(calls: ShimCall[]): { env: NodeJS.ProcessEnv; countFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'supremo-npm-audit-guard-e2e-'))
  const binDir = join(dir, 'bin')
  mkdirSync(binDir, { recursive: true })
  const { countFile } = writeStatefulNpmShim(binDir, calls)
  return {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      // Backoff quase zero — os testes não podem gastar segundos reais.
      SUPREMO_NPM_AUDIT_BACKOFF_MS: '5,5',
    },
    countFile,
  }
}

function runGuard(env: NodeJS.ProcessEnv): { status: number; output: string } {
  try {
    const output = execFileSync(TSX_BIN, [GUARD_SCRIPT], { cwd: ROOT, env, encoding: 'utf8' })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string }
    return { status: e.status ?? 1, output: `${e.stdout}${e.stderr}` }
  }
}

function callCount(countFile: string): number {
  return Number(readFileSync(countFile, 'utf8').trim())
}

const VULN_OUTPUT = `
# npm audit report

lodash  <4.17.21
Severity: high
Prototype Pollution - https://github.com/advisories/GHSA-jf85-cpcp-j695

1 high severity vulnerability
`

const TRANSIENT_503 = `npm error code E503
npm error 503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk`

const REAL_ERROR_403 = `npm error code E403
npm error 403 Forbidden - GET https://registry.npmjs.org/some-private-pkg - Forbidden`

const SUCCESS_OUTPUT = 'found 0 vulnerabilities'

describe('npm-audit-guard.mts — execução real: retry só em instabilidade transitória', () => {
  it('vulnerabilidade real → falha imediata, NUNCA tenta de novo (1 chamada só)', () => {
    const { env, countFile } = setup([{ exitCode: 1, output: VULN_OUTPUT }])
    const { status, output } = runGuard(env)

    expect(status).not.toBe(0)
    expect(output).toContain('vulnerabilidade high/critical')
    expect(output).not.toMatch(/nova tentativa/)
    expect(callCount(countFile)).toBe(1)
  })

  it('erro real do npm (403) → falha imediata, NUNCA tenta de novo (1 chamada só)', () => {
    const { env, countFile } = setup([{ exitCode: 1, output: REAL_ERROR_403 }])
    const { status, output } = runGuard(env)

    expect(status).not.toBe(0)
    expect(output).toContain('erro real do npm')
    expect(output).not.toMatch(/nova tentativa/)
    expect(callCount(countFile)).toBe(1)
  })

  it('falha transitória (503) nas duas primeiras chamadas, sucesso na 3ª → CI passa', () => {
    const { env, countFile } = setup([
      { exitCode: 1, output: TRANSIENT_503 },
      { exitCode: 1, output: TRANSIENT_503 },
      { exitCode: 0, output: SUCCESS_OUTPUT },
    ])
    const { status, output } = runGuard(env)

    expect(status).toBe(0)
    expect(output).toContain('passou na tentativa 3/3')
    expect(callCount(countFile)).toBe(3)
  })

  it('falha transitória em TODAS as 3 tentativas → CI continua vermelha (nunca ignora, nunca faz bypass)', () => {
    const { env, countFile } = setup([
      { exitCode: 1, output: TRANSIENT_503 },
      { exitCode: 1, output: TRANSIENT_503 },
      { exitCode: 1, output: TRANSIENT_503 },
    ])
    const { status, output } = runGuard(env)

    expect(status).not.toBe(0)
    expect(output).toContain('3/3 tentativas')
    expect(output).toContain('CI continua vermelha')
    // Nunca tenta uma 4ª vez além do limite configurado.
    expect(callCount(countFile)).toBe(3)
  })

  it('sucesso já na 1ª tentativa → passa sem qualquer menção a retry', () => {
    const { env, countFile } = setup([{ exitCode: 0, output: SUCCESS_OUTPUT }])
    const { status, output } = runGuard(env)

    expect(status).toBe(0)
    expect(output).not.toMatch(/nova tentativa|tentativa \d\/\d/)
    expect(callCount(countFile)).toBe(1)
  })
})
