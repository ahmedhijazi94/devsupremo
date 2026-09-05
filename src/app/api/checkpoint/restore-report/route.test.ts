import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Testes COMPORTAMENTAIS de /api/checkpoint/restore-report — exercitam o route
 * handler de verdade (não só grep no texto-fonte). Cobrem exatamente os 3
 * invariantes pedidos:
 *   1. device secret ausente/inválido é rejeitado ANTES de qualquer operação;
 *   2. só aceita device autenticado E autorizado para o PROJETO CORRETO do
 *      restoreRequestId (a rota usa service_role — RLS não protege aqui; a
 *      autorização de dono É o código, ver authorizeRestoreReport);
 *   3. fail-closed: em qualquer recusa, nenhuma escrita acontece (os spies de
 *      report* nunca são chamados).
 *
 * Só a resolução do device/dono e as escritas são dubladas (dependem do
 * banco); a decisão de autorização roda de verdade.
 */

const authenticateDeviceSecret = vi.fn()
const getRestoreRequestProjectOwner = vi.fn()
const reportRestoreApplied = vi.fn()
const reportRestoreFailed = vi.fn()

vi.mock('@/lib/supabase/admin', () => ({
  createServiceClient: () => ({}) as never,
}))

vi.mock('@/lib/checkpoint/devices', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/checkpoint/devices')>(
      '@/lib/checkpoint/devices',
    )
  return {
    ...actual,
    authenticateDeviceSecret: (...args: unknown[]) => authenticateDeviceSecret(...args),
  }
})

vi.mock('@/lib/checkpoint/store', () => ({
  supabaseCheckpointDeviceStore: () => ({}) as never,
  getRestoreRequestProjectOwner: (...args: unknown[]) => getRestoreRequestProjectOwner(...args),
  reportRestoreApplied: (...args: unknown[]) => reportRestoreApplied(...args),
  reportRestoreFailed: (...args: unknown[]) => reportRestoreFailed(...args),
}))

const { POST } = await import('./route')

const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222'
const RESTORE_REQUEST_ID = '33333333-3333-4333-8333-333333333333'
const RESULT_CHECKPOINT_ID = '44444444-4444-4444-8444-444444444444'

function request(body: unknown) {
  return new Request('http://localhost/api/checkpoint/restore-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  authenticateDeviceSecret.mockReset()
  getRestoreRequestProjectOwner.mockReset()
  reportRestoreApplied.mockReset()
  reportRestoreFailed.mockReset()
})

describe('device secret ausente/inválido — rejeitado ANTES de qualquer operação (teste 1)', () => {
  it('sem deviceSecret → 400, autenticação NUNCA chamada', async () => {
    const res = await POST(
      request({
        restoreRequestId: RESTORE_REQUEST_ID,
        status: 'applied',
        resultCheckpointId: null,
      }) as never,
    )
    expect(res.status).toBe(400)
    expect(authenticateDeviceSecret).not.toHaveBeenCalled()
    expect(reportRestoreApplied).not.toHaveBeenCalled()
  })

  it('deviceSecret curto/inválido pela forma (zod) → 400, autenticação NUNCA chamada', async () => {
    const res = await POST(
      request({
        deviceSecret: 'x',
        restoreRequestId: RESTORE_REQUEST_ID,
        status: 'applied',
        resultCheckpointId: null,
      }) as never,
    )
    expect(res.status).toBe(400)
    expect(authenticateDeviceSecret).not.toHaveBeenCalled()
  })

  it('deviceSecret bem formado mas REVOGADO/desconhecido → 401, nenhuma escrita', async () => {
    authenticateDeviceSecret.mockResolvedValue({ ok: false, reason: 'revoked' })
    const res = await POST(
      request({
        deviceSecret: 'sup_dev_ckpt_valido_mas_revogado',
        restoreRequestId: RESTORE_REQUEST_ID,
        status: 'applied',
        resultCheckpointId: null,
      }) as never,
    )
    expect(res.status).toBe(401)
    expect(getRestoreRequestProjectOwner).not.toHaveBeenCalled()
    expect(reportRestoreApplied).not.toHaveBeenCalled()
    expect(reportRestoreFailed).not.toHaveBeenCalled()
  })
})

describe('só aceita device autenticado E autorizado para o PROJETO CORRETO (teste 2 — IDOR)', () => {
  const deviceSecret = 'sup_dev_ckpt_valido'

  it('restoreRequestId de OUTRO dono → 404, escrita NUNCA acontece (fail-closed)', async () => {
    authenticateDeviceSecret.mockResolvedValue({
      ok: true,
      device: { id: 'dev-1', ownerUserId: OWNER },
    })
    // O restore_request pedido pertence a um projeto de OUTRO usuário.
    getRestoreRequestProjectOwner.mockResolvedValue({ projectOwnerUserId: OTHER_OWNER })

    const res = await POST(
      request({
        deviceSecret,
        restoreRequestId: RESTORE_REQUEST_ID,
        status: 'applied',
        resultCheckpointId: RESULT_CHECKPOINT_ID,
      }) as never,
    )
    expect(res.status).toBe(404) // não 403: não revela se o id existe
    expect(reportRestoreApplied).not.toHaveBeenCalled()
    expect(reportRestoreFailed).not.toHaveBeenCalled()
  })

  it('restoreRequestId inexistente → 404, escrita NUNCA acontece', async () => {
    authenticateDeviceSecret.mockResolvedValue({
      ok: true,
      device: { id: 'dev-1', ownerUserId: OWNER },
    })
    getRestoreRequestProjectOwner.mockResolvedValue(null)

    const res = await POST(
      request({
        deviceSecret,
        restoreRequestId: RESTORE_REQUEST_ID,
        status: 'failed',
        error: 'x',
      }) as never,
    )
    expect(res.status).toBe(404)
    expect(reportRestoreFailed).not.toHaveBeenCalled()
  })

  it('device é dono do MESMO projeto do restoreRequest → 200, escreve exatamente uma vez', async () => {
    authenticateDeviceSecret.mockResolvedValue({
      ok: true,
      device: { id: 'dev-1', ownerUserId: OWNER },
    })
    getRestoreRequestProjectOwner.mockResolvedValue({ projectOwnerUserId: OWNER })
    reportRestoreApplied.mockResolvedValue(undefined)

    const res = await POST(
      request({
        deviceSecret,
        restoreRequestId: RESTORE_REQUEST_ID,
        status: 'applied',
        resultCheckpointId: RESULT_CHECKPOINT_ID,
      }) as never,
    )
    expect(res.status).toBe(200)
    expect(reportRestoreApplied).toHaveBeenCalledTimes(1)
    expect(reportRestoreApplied).toHaveBeenCalledWith(
      expect.anything(),
      RESTORE_REQUEST_ID,
      RESULT_CHECKPOINT_ID,
    )
    expect(reportRestoreFailed).not.toHaveBeenCalled()
  })

  it('status "failed" (mesmo dono) → chama reportRestoreFailed, não Applied', async () => {
    authenticateDeviceSecret.mockResolvedValue({
      ok: true,
      device: { id: 'dev-1', ownerUserId: OWNER },
    })
    getRestoreRequestProjectOwner.mockResolvedValue({ projectOwnerUserId: OWNER })
    reportRestoreFailed.mockResolvedValue(undefined)

    const res = await POST(
      request({
        deviceSecret,
        restoreRequestId: RESTORE_REQUEST_ID,
        status: 'failed',
        error: 'checkpoint alvo não encontrado localmente',
      }) as never,
    )
    expect(res.status).toBe(200)
    expect(reportRestoreFailed).toHaveBeenCalledTimes(1)
    expect(reportRestoreApplied).not.toHaveBeenCalled()
  })
})
