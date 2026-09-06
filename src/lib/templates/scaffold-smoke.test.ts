import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildProjectFiles } from './project-files'

/**
 * SMOKE TEST do scaffold × CLI real (v3.1 finalização, seção 36).
 *
 * Existe por causa de um bug real em produção: `npm run daemon:status` do
 * projeto gerado falhava com "unknown option '--status'" e `npm run checkpoint`
 * caía na ponte MCP com um erro de SUPREMO_URL completamente desconexo. A causa
 * era a versão PUBLICADA da CLI estar desatualizada — mas nada nos testes
 * unitários (que testam o gerador e a CLI separadamente, cada um "correto" no
 * seu próprio mundo) capturava esse tipo de DESALINHAMENTO entre os dois.
 *
 * Este teste gera o scaffold de verdade e roda os scripts críticos contra o
 * BIN REAL desta CLI (packages/cli/dist/bin.js, o mesmo publicado) — não
 * `npx --yes supremo-cli` (que bateria na rede e testaria a versão errada). Se
 * o template referenciar um comando/opção que a CLI não tem, ESTE teste
 * quebra — não descobrimos mais isso só no E2E de produção.
 */

const CLI_BIN = path.resolve(__dirname, '../../../packages/cli/dist/bin.js')

function cliAvailable(): boolean {
  return fs.existsSync(CLI_BIN)
}

/** `supremo <cmd> --help` — barato, sem rede/git real, prova que o comando (e
 * cada opção) existe DE VERDADE nesta CLI, não só na intenção do template. */
function helpOutput(args: string[]): string {
  return execFileSync(process.execPath, [CLI_BIN, ...args, '--help'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Do script npm gerado ("npx --yes supremo-cli daemon --status"), extrai
 * ["daemon", "--status"] — o que a CLI REAL precisa reconhecer. */
function commandFromScript(script: string): string[] {
  const parts = script.trim().split(/\s+/)
  const idx = parts.findIndex((p) => p === 'supremo')
  if (idx === -1) return []
  return parts.slice(idx + 1)
}

describe('scaffold smoke — scripts gerados batem com a CLI REAL (não só com a intenção)', () => {
  if (!cliAvailable()) {
    // dist/bin.js não foi buildado nesta checkout (ex.: clone sem `npm run
    // build` em packages/cli) — não é um problema do TEMPLATE; pula com aviso
    // em vez de falhar um teste que não tem o que testar.
    it.skip('packages/cli/dist/bin.js ausente — rode "npm run build" em packages/cli', () => {})
    return
  }

  const files = buildProjectFiles({ projectName: 'smoke-app', description: 'x' })
  const pkg = JSON.parse(
    files.find((f) => f.path === 'package.json')!.content,
  ) as { scripts: Record<string, string> }

  const cliScripts = Object.entries(pkg.scripts).filter(([, cmd]) =>
    cmd.startsWith('supremo '),
  )

  it('o template referencia pelo menos os scripts críticos via supremo-cli', () => {
    const names = cliScripts.map(([name]) => name)
    expect(names).toEqual(
      expect.arrayContaining(['checkpoint', 'daemon:ensure', 'daemon:status', 'daemon:stop']),
    )
  })

  it.each(cliScripts)('"%s" → comando+opção existem na CLI real', (_name, script) => {
    const args = commandFromScript(script)
    expect(args.length).toBeGreaterThan(0)
    const [command, ...flags] = args

    // O comando em si precisa estar REGISTRADO — não só "existir uma CLI
    // supremo". Comando desconhecido cai no help do PROGRAMA (top-level, que
    // também contém "Usage: supremo"), então a checagem tem que ser específica
    // do subcomando (é exatamente essa folga que deixou passar o bug real).
    const help = helpOutput([command!])
    expect(help, `"${command}" não é um comando registrado nesta CLI`).toMatch(
      new RegExp(`^Usage: supremo ${command}\\b`, 'm'),
    )

    // Cada FLAG que o script usa (ex.: --ensure/--status/--stop) precisa
    // aparecer nas opções listadas — não só o nome do comando.
    for (const flag of flags) {
      if (!flag.startsWith('--')) continue
      expect(help, `"${command} ${flag}" não é uma opção reconhecida`).toContain(flag)
    }
  })

  it('checkpoint <summary...> aceita argumento variádico (o resumo do pedido)', () => {
    const help = helpOutput(['checkpoint'])
    expect(help).toMatch(/<summary\.\.\.>/)
  })

  it('nenhum script gerado usa um comando fora do conjunto conhecido da CLI', () => {
    // Espelha o guard de bin.ts: "checkpoint"/"daemon"/"sync" são os únicos
    // comandos de workflow que o template pode referenciar.
    const commands = new Set(cliScripts.map(([, cmd]) => commandFromScript(cmd)[0]))
    for (const c of commands) {
      expect(['checkpoint', 'daemon', 'sync', 'turn', 'host']).toContain(c)
    }
  })
})
