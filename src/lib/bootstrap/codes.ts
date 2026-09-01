import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Bootstrap por DEVICE FLOW (inspirado no RFC 8628).
 *
 * O comando local é `supremo bootstrap <project-id>` — project-id NÃO é segredo.
 * O CLI inicia um device flow: recebe um `device_code` (segredo com que faz poll;
 * só o hash vai ao banco) e mostra um `user_code` curto. O DONO abre o browser
 * (já autenticado) e autoriza; só então o poll do CLI devolve a config. Assim
 * nenhum segredo temporário passa pelo shell history.
 *
 * Estados: pending → approved → consumed | denied. Consumo é atômico (one-time).
 * A checagem de DONO (o usuário é dono do projeto?) é feita na camada de action,
 * antes de aprovar; o store só liga o user_id e garante atomicidade/expiração.
 */

const DEVICE_PREFIX = 'sup_dev_'
const DEVICE_BYTES = 32
// Alfabeto sem caracteres ambíguos (0/O, 1/I/L).
const USER_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const USER_CODE_LEN = 8
export const DEFAULT_TTL_MS = 15 * 60 * 1000 // 15 min
export const POLL_INTERVAL_SEC = 2

export function generateDeviceCode(): string {
  return `${DEVICE_PREFIX}${crypto.randomBytes(DEVICE_BYTES).toString('base64url')}`
}

export function hashDeviceCode(code: string): string {
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex')
}

export function isDeviceCode(value: string): boolean {
  return value.startsWith(DEVICE_PREFIX)
}

/** Código curto humano, formatado XXXX-XXXX. */
export function generateUserCode(): string {
  const bytes = crypto.randomBytes(USER_CODE_LEN)
  let out = ''
  for (let i = 0; i < USER_CODE_LEN; i++) {
    out += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length]
    if (i === 3) out += '-'
  }
  return out
}

/** Normaliza o user_code digitado (maiúsculas, sem espaços; hífen opcional). */
export function normalizeUserCode(input: string): string {
  const cleaned = input.toUpperCase().replace(/[^0-9A-Z]/g, '')
  return cleaned.length === USER_CODE_LEN
    ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`
    : cleaned
}

export interface BootstrapScope {
  userId: string
  projectId: string
}

export interface DeviceGrantRow {
  projectId: string
  deviceCodeHash: string
  userCode: string
  expiresAt: string // ISO
  createdIp?: string | null
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'ready'; scope: BootstrapScope }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'gone' }

export interface GrantSummary {
  projectId: string
  status: 'pending' | 'approved' | 'consumed' | 'denied'
  expired: boolean
}

/**
 * Contrato de armazenamento. `approve` e `claim` DEVEM ser atômicos e respeitar
 * expiração; só mudam de estado a partir do estado esperado.
 */
export interface DeviceGrantStore {
  create(row: DeviceGrantRow): Promise<void>
  findByUserCode(userCode: string, nowIso: string): Promise<GrantSummary | null>
  /** pending → approved, ligando user_id. Devolve o projeto ou null. */
  approve(
    userCode: string,
    userId: string,
    nowIso: string,
  ): Promise<{ projectId: string } | null>
  /** Consulta+consome pelo device_code_hash. */
  poll(deviceCodeHash: string, nowIso: string): Promise<PollResult>
}

// ── Orquestração ────────────────────────────────────────────────────────────

export async function startDeviceGrant(
  store: DeviceGrantStore,
  projectId: string,
  opts: { ttlMs?: number; createdIp?: string | null; now?: number } = {},
): Promise<{
  deviceCode: string
  userCode: string
  expiresAt: string
  intervalSec: number
}> {
  const deviceCode = generateDeviceCode()
  const userCode = generateUserCode()
  const now = opts.now ?? Date.now()
  const expiresAt = new Date(now + (opts.ttlMs ?? DEFAULT_TTL_MS)).toISOString()

  await store.create({
    projectId,
    deviceCodeHash: hashDeviceCode(deviceCode),
    userCode,
    expiresAt,
    createdIp: opts.createdIp ?? null,
  })

  return { deviceCode, userCode, expiresAt, intervalSec: POLL_INTERVAL_SEC }
}

export async function approveDeviceGrant(
  store: DeviceGrantStore,
  userCode: string,
  userId: string,
  opts: { now?: number } = {},
): Promise<{ projectId: string } | null> {
  const nowIso = new Date(opts.now ?? Date.now()).toISOString()
  return store.approve(normalizeUserCode(userCode), userId, nowIso)
}

export async function pollDeviceGrant(
  store: DeviceGrantStore,
  deviceCode: string,
  opts: { now?: number } = {},
): Promise<PollResult> {
  if (!isDeviceCode(deviceCode)) return { status: 'gone' }
  const nowIso = new Date(opts.now ?? Date.now()).toISOString()
  return store.poll(hashDeviceCode(deviceCode), nowIso)
}

export async function lookupGrant(
  store: DeviceGrantStore,
  userCode: string,
  opts: { now?: number } = {},
): Promise<GrantSummary | null> {
  const nowIso = new Date(opts.now ?? Date.now()).toISOString()
  return store.findByUserCode(normalizeUserCode(userCode), nowIso)
}

// ── Store real (Supabase, service_role) ─────────────────────────────────────

export function supabaseBootstrapStore(client: SupabaseClient): DeviceGrantStore {
  return {
    async create(row) {
      const { error } = await client.from('bootstrap_codes').insert({
        project_id: row.projectId,
        device_code_hash: row.deviceCodeHash,
        user_code: row.userCode,
        expires_at: row.expiresAt,
        created_ip: row.createdIp ?? null,
        status: 'pending',
      })
      if (error) throw new Error(`Falha ao iniciar bootstrap: ${error.message}`)
    },

    async findByUserCode(userCode, nowIso) {
      const { data, error } = await client
        .from('bootstrap_codes')
        .select('project_id, status, expires_at')
        .eq('user_code', userCode)
        .maybeSingle()
      if (error || !data) return null
      return {
        projectId: data.project_id as string,
        status: data.status as GrantSummary['status'],
        expired: (data.expires_at as string) <= nowIso,
      }
    },

    async approve(userCode, userId, nowIso) {
      const { data, error } = await client
        .from('bootstrap_codes')
        .update({ status: 'approved', approved_at: nowIso, user_id: userId })
        .eq('user_code', userCode)
        .eq('status', 'pending')
        .gt('expires_at', nowIso)
        .select('project_id')
        .maybeSingle()
      if (error || !data) return null
      return { projectId: data.project_id as string }
    },

    async poll(deviceCodeHash, nowIso) {
      // Consome atomicamente se aprovado e válido.
      const { data: claimed } = await client
        .from('bootstrap_codes')
        .update({ status: 'consumed', consumed_at: nowIso })
        .eq('device_code_hash', deviceCodeHash)
        .eq('status', 'approved')
        .gt('expires_at', nowIso)
        .select('user_id, project_id')
        .maybeSingle()
      if (claimed) {
        return {
          status: 'ready',
          scope: {
            userId: claimed.user_id as string,
            projectId: claimed.project_id as string,
          },
        }
      }

      // Não consumiu: descobre o porquê.
      const { data, error } = await client
        .from('bootstrap_codes')
        .select('status, expires_at')
        .eq('device_code_hash', deviceCodeHash)
        .maybeSingle()
      if (error || !data) return { status: 'gone' }
      if ((data.expires_at as string) <= nowIso) return { status: 'expired' }
      if (data.status === 'pending') return { status: 'pending' }
      if (data.status === 'denied') return { status: 'denied' }
      return { status: 'gone' } // consumed já
    },
  }
}
