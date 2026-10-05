// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ usage: vi.fn(), limits: vi.fn(), administer: vi.fn(), backend: vi.fn() }))
vi.mock('@/actions/backend-observability', () => ({ getBackendUsage: mocks.usage, saveBackendUsageLimits: mocks.limits }))
vi.mock('@/actions/backend-administration', () => ({ administerProjectBackend: mocks.administer }))
vi.mock('@/actions/project-backend', () => ({ runProjectBackend: mocks.backend }))
import { BackendUsageHistory } from './backend-usage-history'
import { BackendFunctionInspector } from './backend-function-inspector'
const scope = { projectId: '11111111-1111-4111-8111-111111111111', expectedRef: 'own-ref', environment: 'development' as const }
const report = { projectRef: scope.expectedRef, environment: scope.environment, current: { observedAt: '2026-10-05T00:00:00Z', metrics: [] },
  history: [{ observedAt: '2026-10-05T00:00:00Z', metrics: [{ name: 'Tamanho do banco', value: null, available: false }] }], limits: [{ metric: 'Tamanho do banco', maximum: 100 }],
  alerts: [{ metric: 'Tamanho do banco', maximum: 100, value: 100, state: 'limit_reached' }], engineQuota: { maximum: 30, enabled: true, note: 'Limite próprio do motor.' }, historyAvailable: true, historyMessage: 'Amostras coletadas, com lacunas explícitas.', providerQuotasAvailable: false }
beforeEach(() => { vi.resetAllMocks(); mocks.usage.mockResolvedValue({ ok: true, report }); mocks.limits.mockResolvedValue({ ok: true }); mocks.backend.mockResolvedValue({ ok: true, projectRef: 'own-ref', environment: 'development', observedAt: '2026-10-05T00:00:00Z', data: { kind: 'logs', items: [] } }) })
afterEach(cleanup)
describe('usage and function operational panel', () => {
  it('records on request, shows gaps and threshold alerts, saves owner preferences with exact scope', async () => {
    render(<BackendUsageHistory {...scope} />)
    expect(mocks.usage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Registrar amostra e abrir histórico' }))
    expect(await screen.findByText(/limite atingido/)).toBeTruthy()
    expect(screen.getByText('Indisponível')).toBeTruthy()
    expect(screen.getByText(/Cotas e faturamento do fornecedor: indisponíveis/)).toBeTruthy()
    expect(mocks.usage).toHaveBeenCalledWith({ ...scope, days: 7 })
    fireEvent.change(screen.getByLabelText('Avisar ao atingir (bytes nos indicadores de tamanho)'), { target: { value: '500' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar limite de alerta' }))
    await waitFor(() => expect(mocks.limits).toHaveBeenCalledWith({ ...scope, limits: [{ metric: 'Tamanho do banco', maximum: 500 }] }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Remover alerta de Tamanho do banco' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Remover alerta de Tamanho do banco' }))
    await waitFor(() => expect(mocks.limits).toHaveBeenLastCalledWith({ ...scope, limits: [] }))
  })
  it('cannot silently overwrite settings when historical storage is unavailable', async () => {
    mocks.usage.mockResolvedValue({ ok: true, report: { ...report, historyAvailable: false, historyMessage: 'Histórico indisponível.' } })
    render(<BackendUsageHistory {...scope} />)
    fireEvent.click(screen.getByRole('button', { name: 'Registrar amostra e abrir histórico' }))
    expect(await screen.findByText('Histórico indisponível.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Salvar limite de alerta' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('inspects archived versions and sanitized code without deploying, and labels the limited signature test honestly', async () => {
    mocks.administer.mockImplementation(async (input: { options: { operation: string } }) => ({ ok: true, data: { operation: input.options.operation,
      data: input.options.operation === 'functions-history' ? { versions: [{ version: 2, createdAt: '2026-10-05T00:00:00Z', hash: 'a'.repeat(64) }], complete: true }
        : input.options.operation === 'functions-code' ? { version: 2, files: [{ path: 'supabase/functions/mail/index.ts', content: 'export function handler() {}', truncated: false, redacted: true }] }
          : { function: { version: 2 }, deliveryVerified: false } } }))
    render(<BackendFunctionInspector {...scope} slug="mail" currentVersion={2} />)
    expect(mocks.administer).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Ver versões guardadas' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Ver código da versão 2' }))
    expect(await screen.findByText('export function handler() {}')).toBeTruthy()
    expect(mocks.administer).toHaveBeenCalledWith(expect.objectContaining({ projectId: scope.projectId, expectedRef: scope.expectedRef, kind: 'function', options: { operation: 'functions-code', environment: 'development', slug: 'mail', version: 2 } }))
    fireEvent.click(screen.getByRole('button', { name: 'Testar assinatura do envio de autenticação' }))
    expect(await screen.findByText(/Envio e entrega de email não foram testados/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Buscar mail nos logs' }))
    await waitFor(() => expect(mocks.backend).toHaveBeenCalledWith(expect.objectContaining({ projectId: scope.projectId, operation: 'logs', source: 'functions', search: 'mail' })))
  })
})
