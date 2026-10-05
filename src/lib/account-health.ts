export type AccountHealth = 'ok' | 'expired' | 'unknown'

export const HEALTH_LABEL: Record<AccountHealth, string> = {
  ok: 'Conectado',
  expired: 'Autorização expirada',
  unknown: 'Não foi possível verificar',
}
