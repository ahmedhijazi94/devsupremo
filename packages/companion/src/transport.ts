import type { CompanionEvent } from './protocol'

/**
 * Canal de comunicação Supremo ↔ companion. Abstrato de propósito: o cérebro do
 * companion (roteador de comandos + gerência de projetos) fala com um Transport,
 * então dá para testá-lo com um fake, sem rede. O Supabase Realtime é só um
 * adapter deste contrato.
 */
export interface Transport {
  /** Conecta (e mantém conectado, com reconexão automática). */
  start(): Promise<void>
  stop(): Promise<void>
  /** Entrega mensagens CRUAS; quem valida é o companion (parse defensivo). */
  onMessage(handler: (raw: unknown) => void): void
  /** Emite um evento para o Supremo. */
  send(event: CompanionEvent): void
}

/** Transport de teste: empurra comandos e captura eventos, sem rede. */
export class FakeTransport implements Transport {
  readonly sent: CompanionEvent[] = []
  private handler: ((raw: unknown) => void) | null = null

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  onMessage(handler: (raw: unknown) => void): void {
    this.handler = handler
  }

  send(event: CompanionEvent): void {
    this.sent.push(event)
  }

  /** Simula uma mensagem chegando do Supremo. */
  deliver(raw: unknown): void {
    this.handler?.(raw)
  }
}
