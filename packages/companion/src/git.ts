import type { Runner } from './runner'

/**
 * Operações de Git. GitHub é a fonte oficial, mas fica FORA do caminho crítico
 * da edição: clone/pull é bootstrap; commit/push é assíncrono. Atrás de uma
 * interface para o project-manager ser testável.
 *
 * Token nunca é persistido no .git/config: injetado por -c http.extraheader por
 * invocação (efêmero) e redigido nos logs.
 */

export interface GitOps {
  clone(repoUrl: string, token: string, dir: string): Promise<void>
  pull(dir: string, token: string): Promise<void>
  status(dir: string): Promise<string>
  commitAndPush(dir: string, message: string, token: string): Promise<void>
}

/** Header de auth efêmero (basic x-access-token), padrão do GitHub. */
function authArgs(token: string): string[] {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return ['-c', `http.extraheader=AUTHORIZATION: basic ${basic}`]
}

export class RealGit implements GitOps {
  constructor(
    private readonly runner: Runner,
    private readonly onLine?: (line: string) => void,
  ) {}

  async clone(repoUrl: string, token: string, dir: string): Promise<void> {
    const code = await this.runner.exec(
      ['git', ...authArgs(token), 'clone', '--depth', '1', repoUrl, dir],
      process.cwd(),
      process.env,
      this.onLine,
    )
    if (code !== 0) throw new Error(`git clone falhou (code ${code}).`)
  }

  async pull(dir: string, token: string): Promise<void> {
    const code = await this.runner.exec(
      ['git', ...authArgs(token), 'pull', '--ff-only'],
      dir,
      process.env,
      this.onLine,
    )
    if (code !== 0) throw new Error(`git pull falhou (code ${code}).`)
  }

  async status(dir: string): Promise<string> {
    let out = ''
    await this.runner.exec(
      ['git', 'status', '--porcelain=v1', '--branch'],
      dir,
      process.env,
      (line) => {
        out += line + '\n'
      },
    )
    return out.trim()
  }

  async commitAndPush(dir: string, message: string, token: string): Promise<void> {
    await this.runner.exec(['git', 'add', '-A'], dir, process.env, this.onLine)
    // Sem mudança: commit falha; tratamos como no-op.
    const commitCode = await this.runner.exec(
      ['git', 'commit', '-m', message],
      dir,
      process.env,
      this.onLine,
    )
    if (commitCode !== 0) return // nada a commitar
    const pushCode = await this.runner.exec(
      ['git', ...authArgs(token), 'push'],
      dir,
      process.env,
      this.onLine,
    )
    if (pushCode !== 0) throw new Error(`git push falhou (code ${pushCode}).`)
  }
}
