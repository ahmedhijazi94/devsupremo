// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BackendInput,
  BackendData,
  BackendResult,
} from '@/lib/project-backend/contract'

const mocks = vi.hoisted(() => ({
  run: vi.fn<(input: BackendInput) => Promise<BackendResult>>(),
}))
vi.mock('@/actions/project-backend', () => ({ runProjectBackend: mocks.run }))
import { BackendConsole } from './backend-console'

const projectId = '11111111-1111-4111-8111-111111111111'
function success(
  kind: BackendInput['operation'],
  items: Record<string, unknown>[] = [],
  extra: Partial<BackendData> = {},
): BackendResult {
  return {
    ok: true,
    data: { kind, items, ...extra },
    environment: 'development',
    projectRef: 'connected-ref',
    observedAt: '2026-09-26T10:00:00Z',
  }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.run.mockImplementation(async (input: BackendInput) =>
    success(input.operation),
  )
})
afterEach(cleanup)

describe('console de dados e serviços', () => {
  it('abre registros e pagina mantendo o projeto e a tabela escolhidos', async () => {
    mocks.run.mockImplementation(async (input: BackendInput) =>
      input.operation === 'tables'
        ? success('tables', [{ schema: 'public', name: 'expenses' }])
        : success(
            'rows',
            [
              {
                id: input.offset === 50 ? 'segunda-pagina' : 'primeira-pagina',
              },
            ],
            { hasMore: input.offset === 0 },
          ),
    )
    render(<BackendConsole projectId={projectId} />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'public.expenses' }),
    )
    expect(await screen.findByText('primeira-pagina')).toBeTruthy()
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Paginação de registros' }),
      ).getByRole('button', { name: 'Próxima' }),
    )
    expect(await screen.findByText('segunda-pagina')).toBeTruthy()
    expect(mocks.run).toHaveBeenCalledWith({
      projectId,
      operation: 'rows',
      table: 'expenses',
      limit: 50,
      offset: 50,
    })
    expect(
      (
        within(
          screen.getByRole('group', { name: 'Paginação de registros' }),
        ).getByRole('button', { name: 'Próxima' }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Paginação de registros' }),
      ).getByRole('button', { name: 'Anterior' }),
    )
    expect(await screen.findByText('primeira-pagina')).toBeTruthy()
  })

  it('não reaproveita uma resposta atrasada ao mudar de projeto', async () => {
    let resolveOld: ((result: BackendResult) => void) | undefined
    mocks.run.mockImplementation((input: BackendInput) =>
      input.projectId === projectId
        ? new Promise<BackendResult>((resolve) => {
            resolveOld = resolve
          })
        : Promise.resolve(success('tables', [{ name: 'other_project_table' }])),
    )
    const view = render(<BackendConsole projectId={projectId} />)
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1))
    view.rerender(
      <BackendConsole projectId="22222222-2222-4222-8222-222222222222" />,
    )
    expect(
      await screen.findByRole('button', { name: 'other_project_table' }),
    ).toBeTruthy()
    await act(async () => {
      resolveOld?.(success('tables', [{ name: 'old_private_table' }]))
    })
    expect(screen.queryByText('old_private_table')).toBeNull()
  })

  it('mantém o SQL após recusa do servidor e só consulta por ação explícita', async () => {
    mocks.run.mockImplementation(async (input: BackendInput) =>
      input.operation === 'query'
        ? { ok: false, error: 'Somente consultas de leitura são permitidas.' }
        : success(input.operation),
    )
    render(<BackendConsole projectId={projectId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Editor SQL' }))
    expect(
      mocks.run.mock.calls.some(
        ([input]: [BackendInput]) => input.operation === 'query',
      ),
    ).toBe(false)
    const field = screen.getByLabelText('Consulta SQL') as HTMLTextAreaElement
    fireEvent.change(field, {
      target: { value: 'delete from public.expenses;' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Executar consulta' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Somente consultas de leitura',
    )
    expect(field.value).toBe('delete from public.expenses;')
    expect(mocks.run).toHaveBeenCalledWith({
      projectId,
      operation: 'query',
      sql: 'delete from public.expenses;',
      limit: 50,
      offset: 0,
    })
    expect(
      (
        screen.getByRole('button', {
          name: 'Executar consulta',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false)
  })

  it('mostra resultado SQL escapado e metadados da consulta', async () => {
    mocks.run.mockImplementation(async (input: BackendInput) =>
      success(
        input.operation,
        input.operation === 'query'
          ? [{ name: '<script>unsafe()</script>', active: false, absent: null }]
          : [],
      ),
    )
    render(<BackendConsole projectId={projectId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Editor SQL' }))
    fireEvent.change(screen.getByLabelText('Consulta SQL'), {
      target: { value: 'select name from public.expenses;' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Executar consulta' }))
    expect(await screen.findByText('<script>unsafe()</script>')).toBeTruthy()
    expect(document.querySelector('script')).toBeNull()
    expect(screen.getByText('Não')).toBeTruthy()
    expect(screen.getByText(/Desenvolvimento · connected-ref/)).toBeTruthy()
  })

  it('pagina o SQL executado mesmo quando o texto do editor já mudou', async () => {
    mocks.run.mockImplementation(async (input) =>
      success(
        input.operation,
        input.operation === 'query'
          ? [{ id: input.offset === 50 ? 'sql-segunda' : 'sql-primeira' }]
          : [],
        { hasMore: input.offset === 0 },
      ),
    )
    render(<BackendConsole projectId={projectId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Editor SQL' }))
    fireEvent.change(screen.getByLabelText('Consulta SQL'), {
      target: { value: 'select id from public.expenses;' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Executar consulta' }))
    expect(await screen.findByText('sql-primeira')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Consulta SQL'), {
      target: { value: 'select name from public.customers;' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Próxima' }))
    expect(await screen.findByText('sql-segunda')).toBeTruthy()
    expect(mocks.run).toHaveBeenLastCalledWith({
      projectId,
      operation: 'query',
      sql: 'select id from public.expenses;',
      limit: 50,
      offset: 50,
    })
  })

  it('usa o destino confirmado para pausar uma tarefa e recarrega após sucesso', async () => {
    let paused = false
    mocks.run.mockImplementation(async (input: BackendInput) => {
      if (input.operation === 'job-set-active') {
        paused = true
        return success(input.operation)
      }
      return success(
        input.operation,
        input.operation === 'jobs'
          ? [
              {
                jobId: 'daily-report',
                name: 'Resumo diário',
                schedule: '0 12 * * *',
                active: !paused,
              },
            ]
          : [],
      )
    })
    render(<BackendConsole projectId={projectId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Agendamentos' }))
    fireEvent.click(
      await screen.findByRole('button', { name: 'Histórico de Resumo diário' }),
    )
    await waitFor(() =>
      expect(mocks.run).toHaveBeenCalledWith({
        projectId,
        operation: 'job-history',
        jobId: 'daily-report',
        limit: 50,
        offset: 0,
      }),
    )
    expect(
      mocks.run.mock.calls.some(
        ([input]: [BackendInput]) => input.operation === 'job-set-active',
      ),
    ).toBe(false)
    fireEvent.click(
      screen.getByRole('button', { name: 'Pausar Resumo diário' }),
    )
    await waitFor(() =>
      expect(mocks.run).toHaveBeenCalledWith({
        projectId,
        operation: 'job-set-active',
        jobId: 'daily-report',
        enabled: false,
        expectedRef: 'connected-ref',
        environment: 'development',
      }),
    )
    expect(
      await screen.findByRole('button', { name: 'Ativar Resumo diário' }),
    ).toBeTruthy()
  })

  it('não altera agendamento cujo ambiente não foi confirmado', async () => {
    mocks.run.mockImplementation(async (input: BackendInput) => ({
      ...success(input.operation, [{ jobId: 'daily', active: true }]),
      environment: 'unknown',
    }))
    render(<BackendConsole projectId={projectId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Agendamentos' }))
    expect(
      (
        (await screen.findByRole('button', {
          name: 'Pausar daily',
        })) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
  })

  it('distingue zero medido de indicadores indisponíveis', async () => {
    mocks.run.mockImplementation(async (input: BackendInput) =>
      success(
        input.operation,
        [],
        input.operation === 'usage'
          ? {
              metrics: [
                { name: 'Execuções', value: 0, available: true },
                {
                  name: 'Tráfego',
                  value: null,
                  available: false,
                  note: 'Não fornecido pelo provedor.',
                },
              ],
            }
          : {},
      ),
    )
    render(<BackendConsole projectId={projectId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Uso' }))
    expect(await screen.findByText('Indisponível')).toBeTruthy()
    expect(screen.getByText('0')).toBeTruthy()
    expect(screen.getByText('Não fornecido pelo provedor.')).toBeTruthy()
  })

  it('consulta o estado da função escolhida sem publicar ou alterá-la', async () => {
    mocks.run.mockImplementation(async (input: BackendInput) =>
      success(
        input.operation,
        input.operation === 'functions'
          ? [{ slug: 'send-email', status: 'ACTIVE' }]
          : input.operation === 'function-status'
            ? [{ version: 7 }]
            : [],
      ),
    )
    render(<BackendConsole projectId={projectId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edge Functions' }))
    fireEvent.click(
      await screen.findByRole('button', { name: 'Detalhes de send-email' }),
    )
    expect(await screen.findByText('7')).toBeTruthy()
    expect(mocks.run).toHaveBeenCalledWith({
      projectId,
      operation: 'function-status',
      slug: 'send-email',
    })
  })

  it('envia os filtros de logs escolhidos e trata falha de transporte com tentativa nova', async () => {
    mocks.run.mockImplementation(async (input: BackendInput) => {
      if (input.operation === 'logs') throw new Error('private upstream error')
      return success(input.operation)
    })
    render(<BackendConsole projectId={projectId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }))
    expect((await screen.findByRole('alert')).textContent).not.toContain(
      'private upstream error',
    )
    mocks.run.mockImplementation(async (input: BackendInput) =>
      success(input.operation),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    fireEvent.change(screen.getByLabelText('Serviço dos logs'), {
      target: { value: 'auth' },
    })
    fireEvent.change(screen.getByLabelText('Nível dos logs'), {
      target: { value: 'error' },
    })
    fireEvent.change(screen.getByLabelText('Período dos logs'), {
      target: { value: '15' },
    })
    await waitFor(() =>
      expect(mocks.run).toHaveBeenCalledWith({
        projectId,
        operation: 'logs',
        source: 'auth',
        minutes: 15,
        level: 'error',
        limit: 50,
        offset: 0,
      }),
    )
  })

  it('abre contas e armazenamento sem inventar registros para resultados vazios', async () => {
    render(<BackendConsole projectId={projectId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Usuários' }))
    expect(
      await screen.findByText('Nenhuma conta cadastrada neste projeto.'),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Armazenamento' }))
    expect(
      await screen.findByText(
        'Nenhum espaço de arquivos criado neste projeto.',
      ),
    ).toBeTruthy()
    expect(mocks.run).toHaveBeenCalledWith({
      projectId,
      operation: 'storage',
      limit: 50,
      offset: 0,
    })
  })
})
