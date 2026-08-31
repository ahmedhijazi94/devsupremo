import type { CompanionCommand } from './protocol'

/**
 * Envia um COMANDO ao canal do usuário pelo HTTP broadcast do Supabase Realtime
 * — do servidor, sem manter socket (compatível com serverless). É por aqui que
 * "comando privilegiado vem pelo Supremo validado", não direto do frontend: a
 * server action valida e chama isto; o navegador nunca publica comando.
 *
 * Comandos NÃO carregam segredo: o companion busca a credencial de git por um
 * endpoint autenticado. Então nada sensível trafega no canal.
 */

export function runtimeChannel(userId: string): string {
  return `runtime:${userId}`
}

export async function broadcastCommand(
  userId: string,
  command: CompanionCommand,
): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error('Supabase não configurado para broadcast (URL/service role).')
  }

  const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      messages: [
        {
          topic: runtimeChannel(userId),
          event: 'command',
          payload: command,
          private: true,
        },
      ],
    }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Broadcast falhou (${res.status}): ${detail.slice(0, 160)}`)
  }
}
