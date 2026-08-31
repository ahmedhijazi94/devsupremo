import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'
import type { CompanionConfig } from './config'
import type { CompanionEvent } from './protocol'
import type { Transport } from './transport'

/**
 * Transport real via Supabase Realtime (serverless-friendly, custo zero).
 *
 * Handshake: o companion troca seu token sup_ por uma sessão de Realtime
 * ESCOPADA ao usuário (o Supremo emite um token de curta duração). Assim ele só
 * entra no canal do próprio usuário — cross-user não é possível. O token de
 * admin nunca sai do servidor.
 *
 * NOTA: esta é a parte que só dá para verificar viva (precisa do endpoint
 * /api/companion/connect no Supremo + Realtime). O contrato e o roteamento já
 * são testados via FakeTransport.
 */

export interface CompanionSession {
  userId: string
  supabaseUrl: string
  supabaseAnonKey: string
  realtimeToken: string
  channel: string
}

/** Troca o token sup_ por uma sessão de Realtime escopada ao usuário. */
export async function handshake(
  config: CompanionConfig,
): Promise<CompanionSession> {
  const res = await fetch(`${config.supremoUrl}/api/companion/connect`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    throw new Error(
      `Handshake falhou (${res.status}). Verifique o token (supremo-runtime login).`,
    )
  }
  const data = (await res.json()) as Partial<CompanionSession>
  if (!data.userId || !data.supabaseUrl || !data.supabaseAnonKey || !data.realtimeToken || !data.channel) {
    throw new Error('Handshake devolveu sessão incompleta.')
  }
  return data as CompanionSession
}

export class SupabaseRealtimeTransport implements Transport {
  private client: SupabaseClient | null = null
  private channel: RealtimeChannel | null = null
  private handler: ((raw: unknown) => void) | null = null

  constructor(private readonly session: CompanionSession) {}

  onMessage(handler: (raw: unknown) => void): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    this.client = createClient(this.session.supabaseUrl, this.session.supabaseAnonKey, {
      auth: { persistSession: false },
    })
    this.client.realtime.setAuth(this.session.realtimeToken)

    const channel = this.client.channel(this.session.channel, {
      // private: RLS em realtime.messages garante que só o dono entra no canal.
      config: { private: true, broadcast: { self: false }, presence: { key: 'companion' } },
    })
    channel.on('broadcast', { event: 'command' }, ({ payload }) => {
      this.handler?.(payload)
    })

    await new Promise<void>((resolve, reject) => {
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // presença = "online" para o Supremo ver o companion ativo.
          void channel.track({ online: true, at: Date.now() })
          resolve()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reject(new Error(`Realtime não conectou: ${status}`))
        }
      })
    })
    this.channel = channel
  }

  send(event: CompanionEvent): void {
    void this.channel?.send({ type: 'broadcast', event: 'event', payload: event })
  }

  async stop(): Promise<void> {
    if (this.channel) await this.client?.removeChannel(this.channel)
    this.channel = null
    this.client = null
  }
}
