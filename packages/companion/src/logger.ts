import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { redactWith } from './redact'

/**
 * Log local do companion, sempre com redação de secrets. Os secrets conhecidos
 * em runtime (token do companion, cloneTokens) são registrados aqui e mascarados
 * em toda linha — nunca vão pro arquivo nem pro console.
 */
export class Logger {
  private secrets = new Set<string>()

  constructor(private readonly filePath: string) {
    try {
      mkdirSync(dirname(filePath), { recursive: true })
    } catch {
      // sem disco pra log não pode derrubar o companion
    }
  }

  /** Registra um valor sensível para ser mascarado em todo log daqui pra frente. */
  addSecret(secret: string | null | undefined): void {
    if (secret && secret.length >= 8) this.secrets.add(secret)
  }

  info(message: string): void {
    this.write('INFO', message)
  }

  error(message: string): void {
    this.write('ERROR', message)
  }

  private write(level: string, message: string): void {
    const safe = redactWith(message, [...this.secrets])
    const line = `${new Date().toISOString()} ${level} ${safe}\n`
    // eslint-disable-next-line no-console
    console.error(line.trimEnd())
    try {
      appendFileSync(this.filePath, line)
    } catch {
      // idem: falha de disco não derruba
    }
  }
}
