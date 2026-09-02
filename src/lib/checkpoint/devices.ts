import crypto from 'node:crypto'

/**
 * Identidade PERSISTENTE da máquina do checkpoint daemon.
 *
 * O usuário autoriza a máquina UMA vez (pelo device flow que o bootstrap já usa).
 * Nesse momento o backend emite um `device secret` de alta entropia — devolvido
 * UMA única vez para o CLI guardar no keychain/armazenamento seguro do SO, NUNCA
 * no projeto. O banco guarda só o SHA-256 do secret (nunca o valor), ligado ao
 * dono. Assim:
 *   • o daemon autentica cada pedido de push com o secret (sobre TLS);
 *   • o Supremo pode REVOGAR a máquina a qualquer momento (revoked_at);
 *   • um vazamento do banco não revela nenhum secret utilizável.
 *
 * Este módulo é PURO (gerar/hash/validar) — o I/O sobre Postgres vive num store
 * adapter, testado pelo E2E.
 */

const SECRET_PREFIX = 'sup_dev_ckpt_'
const SECRET_BYTES = 32

export function generateDeviceSecret(): string {
  return `${SECRET_PREFIX}${crypto.randomBytes(SECRET_BYTES).toString('base64url')}`
}

export function isDeviceSecret(value: string): boolean {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX)
}

export function hashDeviceSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex')
}

/** Linha mínima do device, como o store devolve (nunca inclui o secret puro). */
export interface CheckpointDeviceRow {
  id: string
  ownerUserId: string
  label: string | null
  revokedAt: string | null
}

export type DeviceAuthResult =
  | { ok: true; device: CheckpointDeviceRow }
  | { ok: false; reason: 'unknown_device' | 'revoked' | 'malformed' }

/**
 * Autentica um device a partir do secret apresentado e da linha achada pelo
 * hash. PURA: a busca por hash é I/O do store; aqui só validamos o formato e a
 * revogação. Device revogado ou inexistente NUNCA autentica (fail-closed).
 */
export function authenticateDevice(
  secret: string,
  row: CheckpointDeviceRow | null,
): DeviceAuthResult {
  if (!isDeviceSecret(secret)) return { ok: false, reason: 'malformed' }
  if (!row) return { ok: false, reason: 'unknown_device' }
  if (row.revokedAt !== null) return { ok: false, reason: 'revoked' }
  return { ok: true, device: row }
}

/** Contrato de armazenamento do device (adapter Postgres implementa). */
export interface CheckpointDeviceStore {
  /** Cria um device para o dono; devolve o id gerado. Guarda só o hash. */
  create(input: {
    ownerUserId: string
    secretHash: string
    label: string | null
  }): Promise<{ id: string }>
  /** Busca pelo hash do secret (retorna null se não existir). */
  findBySecretHash(secretHash: string): Promise<CheckpointDeviceRow | null>
  /** Marca last_seen_at (observabilidade; best-effort). */
  touch(id: string, nowIso: string): Promise<void>
  /** Revoga um device do dono (idempotente). */
  revoke(id: string, ownerUserId: string, nowIso: string): Promise<void>
}

/**
 * Registra uma máquina nova: gera o secret, guarda só o hash, devolve o secret
 * UMA vez. O chamador (adapter de bootstrap) entrega o secret ao CLI pelo canal
 * seguro; ninguém mais volta a vê-lo.
 */
export async function registerDevice(
  store: CheckpointDeviceStore,
  input: { ownerUserId: string; label: string | null },
): Promise<{ deviceId: string; deviceSecret: string }> {
  const deviceSecret = generateDeviceSecret()
  const { id } = await store.create({
    ownerUserId: input.ownerUserId,
    secretHash: hashDeviceSecret(deviceSecret),
    label: input.label,
  })
  return { deviceId: id, deviceSecret }
}

/**
 * Autentica um secret apresentado pelo daemon: busca pelo hash e valida. Nunca
 * loga o secret. Retorna a identidade do device ou o motivo da recusa.
 */
export async function authenticateDeviceSecret(
  store: CheckpointDeviceStore,
  secret: string,
): Promise<DeviceAuthResult> {
  if (!isDeviceSecret(secret)) return { ok: false, reason: 'malformed' }
  const row = await store.findBySecretHash(hashDeviceSecret(secret))
  return authenticateDevice(secret, row)
}
