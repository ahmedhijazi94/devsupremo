import { execFile } from 'node:child_process'
import readline from 'node:readline'

/**
 * Auth Orchestrator — o padrão ÚNICO de autorização de todo provider do CLI
 * (device flow do Supremo, login do Supabase e futuras integrações, ex.: Lovable).
 *
 * Contrato inviolável:
 *   • NUNCA inventa autenticação própria — só orquestra o fluxo OFICIAL do
 *     provider (OAuth/device flow/CLI login).
 *   • Detecta se a credencial válida JÁ existe nesta máquina; se existe, segue
 *     sem nenhuma interação.
 *   • Se a autorização é necessária, mostra
 *     "<X> precisa ser autorizado nesta máquina. Pressione ENTER para continuar…",
 *     ao ENTER abre o navegador no fluxo oficial, aguarda a conclusão e detecta o
 *     sucesso — sem pedir para copiar URL/código (isso só aparece como fallback
 *     se a abertura automática falhar).
 *
 * Zero configuração manual; a autorização humana continua obrigatória quando o
 * provider exigir.
 */
export interface AuthProvider {
  /** Nome exibido no ✓ e no prompt: "Supremo", "Supabase". */
  name: string
  /** Mensagem do prompt quando a autorização for necessária (sobrepõe o padrão). */
  prompt?: string
  /** A credencial válida já existe nesta máquina? (checagem barata) */
  isAuthorized(): boolean | Promise<boolean>
  /** Conduz o fluxo OFICIAL (abre o browser, aguarda). Lança/erra se não concluir. */
  authorize(): void | Promise<void>
}

export interface AuthIO {
  ok(message: string): void
  info(message: string): void
  /** Mostra a mensagem e resolve quando o humano aperta ENTER (ou já, se não-TTY). */
  waitForEnter(message: string): Promise<void>
}

export const defaultAuthIO: AuthIO = {
  ok: (m) => console.log(`✓ ${m}`),
  info: (m) => console.log(m),
  waitForEnter: (message) =>
    new Promise<void>((resolve) => {
      // Sem terminal interativo (CI/pipe): não há ENTER a esperar — segue.
      if (!process.stdin.isTTY) {
        console.log(message)
        resolve()
        return
      }
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })
      rl.question(`${message} `, () => {
        rl.close()
        resolve()
      })
    }),
}

/**
 * Abre a URL no navegador padrão do SO. Best-effort: devolve false se não
 * conseguiu (o chamador então mostra a URL como fallback).
 */
export function openBrowser(url: string): Promise<boolean> {
  const [cmd, args] =
    process.platform === 'darwin'
      ? (['open', [url]] as const)
      : process.platform === 'win32'
        ? (['cmd', ['/c', 'start', '', url]] as const)
        : (['xdg-open', [url]] as const)
  return new Promise<boolean>((resolve) => {
    try {
      const child = execFile(cmd, [...args], (err) => resolve(!err))
      child.on('error', () => resolve(false))
    } catch {
      resolve(false)
    }
  })
}

/**
 * Garante a autorização de um provider seguindo o padrão único.
 * Retorna true se, ao final, a credencial está válida.
 */
export async function ensureAuthorized(
  provider: AuthProvider,
  io: AuthIO = defaultAuthIO,
): Promise<boolean> {
  if (await provider.isAuthorized()) {
    io.ok(`${provider.name} autorizado`)
    return true
  }
  const message =
    provider.prompt ??
    `${provider.name} precisa ser autorizado nesta máquina. Pressione ENTER para continuar…`
  await io.waitForEnter(message)
  await provider.authorize()
  if (await provider.isAuthorized()) {
    io.ok(`${provider.name} autorizado`)
    return true
  }
  return false
}
