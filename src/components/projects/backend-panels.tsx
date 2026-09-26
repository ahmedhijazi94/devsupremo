'use client'

import { useState, type FormEvent } from 'react'
import { Loader2, Play, Pause, ChevronRight } from 'lucide-react'
import { runProjectBackend } from '@/actions/project-backend'
import type {
  BackendInput,
  BackendResult,
} from '@/lib/project-backend/contract'
import {
  BackendResource,
  BackendMetadata,
  backendButton,
  backendField,
  type BackendSuccess,
} from './backend-resource'
import { BackendTable, BackendPagination } from './backend-table'

const PAGE_SIZE = 50

export function BackendTables({ projectId }: { projectId: string }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [tableOffset, setTableOffset] = useState(0)
  const [offset, setOffset] = useState(0)
  return (
    <div className="space-y-6">
      <p className="text-muted text-xs">Credenciais e outros campos sensíveis aparecem ocultos nas consultas.</p>
      <BackendResource
        input={{
          projectId,
          operation: 'tables',
          limit: PAGE_SIZE,
          offset: tableOffset,
        }}
        label="Tabelas disponíveis"
      >
        {({ data }) =>
          data.items.length ? (
            <>
              <div className="flex flex-wrap gap-2">
                {data.items.map(
                  (table, index) =>
                    typeof table.name === 'string' && (
                      <button
                        key={`${table.name}-${index}`}
                        type="button"
                        aria-pressed={selected === table.name}
                        className={`${backendButton} ${selected === table.name ? 'ring-ink ring-2' : ''}`}
                        onClick={() => {
                          setSelected(String(table.name))
                          setOffset(0)
                        }}
                      >
                        {typeof table.schema === 'string'
                          ? `${table.schema}.`
                          : ''}
                        {table.name}
                        <ChevronRight aria-hidden="true" className="h-3 w-3" />
                      </button>
                    ),
                )}
              </div>
              <BackendPagination
                label="Paginação de tabelas"
                offset={tableOffset}
                count={data.items.length}
                limit={PAGE_SIZE}
                hasMore={data.hasMore === true && data.nextOffset !== null}
                onChange={setTableOffset}
              />
            </>
          ) : (
            <p role="status" className="text-muted text-sm">
              Nenhuma tabela disponível para consulta.
            </p>
          )
        }
      </BackendResource>
      {selected ? (
        <BackendResource
          input={{
            projectId,
            operation: 'rows',
            table: selected,
            limit: PAGE_SIZE,
            offset,
          }}
          label={`Registros de ${selected}`}
        >
          {({ data }) => (
            <>
              <BackendTable
                rows={data.items}
                columns={data.columns}
                caption={`Registros de ${selected}`}
              />
              <BackendPagination
                offset={offset}
                count={data.items.length}
                limit={PAGE_SIZE}
                hasMore={data.hasMore === true && data.nextOffset !== null}
                onChange={setOffset}
              />
            </>
          )}
        </BackendResource>
      ) : (
        <p className="text-muted bg-sunken rounded-xl p-5 text-sm">
          Selecione uma tabela para abrir seus registros.
        </p>
      )}
    </div>
  )
}

export function BackendSql({ projectId }: { projectId: string }) {
  const [sql, setSql] = useState('')
  const [executedSql, setExecutedSql] = useState('')
  const [offset, setOffset] = useState(0)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<BackendResult | null>(null)
  async function execute(query: string, pageOffset: number) {
    setPending(true)
    setResult(null)
    try {
      setResult(
        await runProjectBackend({
          projectId,
          operation: 'query',
          sql: query,
          limit: PAGE_SIZE,
          offset: pageOffset,
        }),
      )
    } catch {
      setResult({
        ok: false,
        error:
          'Não foi possível executar a consulta. Seu texto foi preservado.',
      })
    } finally {
      setPending(false)
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setExecutedSql(sql)
    setOffset(0)
    void execute(sql, 0)
  }
  return (
    <div>
      <form onSubmit={submit} className="space-y-3">
        <label htmlFor="backend-sql" className="block text-sm font-medium">
          Consulta SQL
        </label>
        <textarea
          id="backend-sql"
          value={sql}
          onChange={(event) => setSql(event.target.value)}
          className={`${backendField} min-h-52 font-mono text-xs`}
          spellCheck={false}
          placeholder="select * from public.sua_tabela limit 50;"
          aria-describedby="backend-sql-note"
        />
        <p id="backend-sql-note" className="text-muted text-xs">
          Consultas de leitura. Alterações de estrutura e dados seguem pelo
          agente, com migrations e validação.
        </p>
        <button
          type="submit"
          disabled={pending}
          className="bg-accent text-accent-ink inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs font-medium disabled:opacity-40"
        >
          {pending ? (
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          ) : (
            <Play aria-hidden="true" className="h-4 w-4" />
          )}
          {pending ? 'Consultando…' : 'Executar consulta'}
        </button>
      </form>
      {result && (
        <div className="mt-6" aria-live="polite">
          {result.ok ? (
            <>
              <h3 className="mb-3 text-sm font-semibold">Resultado</h3>
              {result.data.message && (
                <p className="text-muted mb-3 text-sm">{result.data.message}</p>
              )}
              <BackendTable
                rows={result.data.items}
                columns={result.data.columns}
                caption="Resultado da consulta SQL"
              />
              <BackendPagination
                offset={offset}
                count={result.data.items.length}
                limit={PAGE_SIZE}
                hasMore={
                  result.data.hasMore === true &&
                  result.data.nextOffset !== null
                }
                pending={pending}
                onChange={(next) => {
                  setOffset(next)
                  void execute(executedSql, next)
                }}
              />
              <BackendMetadata result={result} />
            </>
          ) : (
            <p
              role="alert"
              className="bg-down text-down-ink rounded-xl p-4 text-sm"
            >
              {result.error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function BackendFunctions({ projectId }: { projectId: string }) {
  const [slug, setSlug] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  return (
    <div className="space-y-6">
      <BackendResource
        input={{ projectId, operation: 'functions', limit: PAGE_SIZE, offset }}
        label="Funções publicadas"
      >
        {({ data }) => (
          <>
            <BackendTable
              rows={data.items}
              columns={data.columns}
              caption="Funções publicadas"
              empty="Nenhuma função publicada neste projeto."
            />
            {data.items.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {data.items.map(
                  (item, index) =>
                    typeof item.slug === 'string' && (
                      <button
                        key={`${item.slug}-${index}`}
                        type="button"
                        className={backendButton}
                        aria-pressed={slug === item.slug}
                        onClick={() => setSlug(String(item.slug))}
                      >
                        Detalhes de {item.slug}
                      </button>
                    ),
                )}
              </div>
            )}
            <BackendPagination
              offset={offset}
              count={data.items.length}
              limit={PAGE_SIZE}
              hasMore={data.hasMore === true && data.nextOffset !== null}
              onChange={setOffset}
            />
          </>
        )}
      </BackendResource>
      {slug && (
        <BackendResource
          input={{ projectId, operation: 'function-status', slug }}
          label={`Detalhes de ${slug}`}
        >
          {({ data }) => (
            <BackendTable
              rows={data.items}
              columns={data.columns}
              caption={`Estado de ${slug}`}
            />
          )}
        </BackendResource>
      )}
      <p className="text-muted text-xs">
        Peça ao agente para criar, publicar ou atualizar uma função. Os dados de
        acesso ficam no servidor.
      </p>
    </div>
  )
}

export function BackendJobs({ projectId }: { projectId: string }) {
  return (
    <BackendResource
      input={{ projectId, operation: 'jobs' }}
      label="Tarefas recorrentes"
    >
      {(result, refresh) => (
        <JobsList projectId={projectId} result={result} refresh={refresh} />
      )}
    </BackendResource>
  )
}

function JobsList({
  projectId,
  result,
  refresh,
}: {
  projectId: string
  result: BackendSuccess
  refresh: () => void
}) {
  const [history, setHistory] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function toggle(jobId: string, enabled: boolean) {
    setPending(jobId)
    setError(null)
    try {
      const response = await runProjectBackend({
        projectId,
        operation: 'job-set-active',
        jobId,
        enabled,
        expectedRef: result.projectRef,
        environment: result.environment,
      })
      if (!response.ok) setError(response.error)
      else refresh()
    } catch {
      setError(
        'Não foi possível confirmar a alteração. Atualize os agendamentos antes de tentar novamente.',
      )
    } finally {
      setPending(null)
    }
  }
  return (
    <div className="space-y-4">
      {error && (
        <p
          role="alert"
          className="bg-down text-down-ink rounded-xl p-4 text-sm"
        >
          {error}
        </p>
      )}
      {result.data.items.length ? (
        result.data.items.map((job, index) => {
          const jobId = typeof job.jobId === 'string' ? job.jobId : null
          const name =
            typeof job.name === 'string'
              ? job.name
              : (jobId ?? `Agendamento ${index + 1}`)
          return (
            <article
              key={jobId ?? index}
              className="border-line rounded-xl border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold">{name}</h4>
                  <p className="text-muted mt-1 text-xs">
                    {typeof job.schedule === 'string'
                      ? `${job.schedule} · UTC`
                      : 'Horário indisponível'}
                  </p>
                  <p className="mt-2 text-xs">
                    {job.active === true
                      ? 'Ativo'
                      : job.active === false
                        ? 'Pausado'
                        : 'Estado indisponível'}
                  </p>
                  {typeof job.target === 'string' && (
                    <p className="text-muted mt-1 text-xs">
                      {job.type === 'function' ? 'Função' : 'Tabela'}:{' '}
                      {job.target}
                    </p>
                  )}
                  {job.synchronized === false && (
                    <p className="text-wait-ink mt-2 text-xs">
                      A configuração mudou no provedor. Peça ao agente para
                      revisar esta tarefa.
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {jobId && (
                    <>
                      <button
                        type="button"
                        className={backendButton}
                        onClick={() =>
                          setHistory(history === jobId ? null : jobId)
                        }
                      >
                        Histórico de {name}
                      </button>
                      <button
                        type="button"
                        className={backendButton}
                        disabled={
                          pending !== null ||
                          typeof job.active !== 'boolean' ||
                          result.environment === 'unknown'
                        }
                        onClick={() => void toggle(jobId, !job.active)}
                        aria-label={`${job.active ? 'Pausar' : 'Ativar'} ${name}`}
                      >
                        {pending === jobId ? (
                          <Loader2
                            aria-hidden="true"
                            className="h-3.5 w-3.5 animate-spin"
                          />
                        ) : job.active ? (
                          <Pause aria-hidden="true" className="h-3.5 w-3.5" />
                        ) : (
                          <Play aria-hidden="true" className="h-3.5 w-3.5" />
                        )}
                        {job.active ? 'Pausar' : 'Ativar'}
                      </button>
                    </>
                  )}
                </div>
              </div>
              {jobId && history === jobId && (
                <div className="mt-5">
                  <JobHistory projectId={projectId} jobId={jobId} name={name} />
                </div>
              )}
            </article>
          )
        })
      ) : (
        <p
          role="status"
          className="text-muted bg-sunken rounded-xl p-5 text-sm"
        >
          Nenhuma tarefa recorrente neste projeto.
        </p>
      )}
      <p className="text-muted text-xs">
        Para criar ou alterar uma tarefa, diga ao agente o que deve acontecer e
        em qual horário. A programação exibida usa UTC.
      </p>
    </div>
  )
}

function JobHistory({
  projectId,
  jobId,
  name,
}: {
  projectId: string
  jobId: string
  name: string
}) {
  const [offset, setOffset] = useState(0)
  return (
    <BackendResource
      input={{
        projectId,
        operation: 'job-history',
        jobId,
        limit: PAGE_SIZE,
        offset,
      }}
      label={`Execuções de ${name}`}
    >
      {({ data }) => (
        <>
          <BackendTable
            rows={data.items}
            columns={data.columns}
            caption={`Execuções de ${name}`}
            empty="Nenhuma execução registrada para esta tarefa."
          />
          <BackendPagination
            offset={offset}
            count={data.items.length}
            limit={PAGE_SIZE}
            hasMore={data.hasMore === true && data.nextOffset !== null}
            onChange={setOffset}
          />
        </>
      )}
    </BackendResource>
  )
}

export function BackendLogs({ projectId }: { projectId: string }) {
  const [source, setSource] =
    useState<NonNullable<BackendInput['source']>>('functions')
  const [level, setLevel] = useState<NonNullable<BackendInput['level']>>('all')
  const [minutes, setMinutes] = useState(60)
  const [offset, setOffset] = useState(0)
  return (
    <div>
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <label className="text-xs font-medium">
          Serviço
          <select
            aria-label="Serviço dos logs"
            className={`${backendField} mt-1`}
            value={source}
            onChange={(event) => {
              setSource(
                event.target.value as NonNullable<BackendInput['source']>,
              )
              setOffset(0)
            }}
          >
            <option value="functions">Edge Functions</option>
            <option value="postgres">Banco de dados</option>
            <option value="auth">Autenticação</option>
            <option value="api">API</option>
            <option value="storage">Armazenamento</option>
            <option value="realtime">Tempo real</option>
          </select>
        </label>
        <label className="text-xs font-medium">
          Período
          <select
            aria-label="Período dos logs"
            className={`${backendField} mt-1`}
            value={minutes}
            onChange={(event) => {
              setMinutes(Number(event.target.value))
              setOffset(0)
            }}
          >
            <option value={15}>Últimos 15 minutos</option>
            <option value={60}>Última hora</option>
            <option value={1440}>Últimas 24 horas</option>
          </select>
        </label>
        <label className="text-xs font-medium">
          Eventos
          <select
            aria-label="Nível dos logs"
            className={`${backendField} mt-1`}
            value={level}
            onChange={(event) => {
              setLevel(event.target.value as NonNullable<BackendInput['level']>)
              setOffset(0)
            }}
          >
            <option value="all">Todos</option>
            <option value="error">Somente erros</option>
          </select>
        </label>
      </div>
      <BackendResource
        input={{
          projectId,
          operation: 'logs',
          source,
          minutes,
          level,
          limit: PAGE_SIZE,
          offset,
        }}
        label="Eventos recentes"
      >
        {({ data }) => (
          <>
            <BackendTable
              rows={data.items}
              columns={data.columns}
              caption="Logs do projeto"
              empty="Nenhum evento encontrado no período e nos filtros escolhidos."
            />
            <BackendPagination
              offset={offset}
              count={data.items.length}
              limit={PAGE_SIZE}
              hasMore={data.hasMore === true && data.nextOffset !== null}
              onChange={setOffset}
            />
          </>
        )}
      </BackendResource>
    </div>
  )
}

export function BackendUsage({ projectId }: { projectId: string }) {
  return (
    <BackendResource
      input={{ projectId, operation: 'usage' }}
      label="Indicadores atuais"
    >
      {({ data }) => (
        <>
          {data.metrics?.length ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {data.metrics.map((metric, index) => (
                <article
                  className="bg-sunken rounded-xl p-4"
                  key={`${metric.name}-${index}`}
                >
                  <h4 className="text-muted text-xs font-medium">
                    {metric.name}
                  </h4>
                  <p className="mt-3 text-xl font-semibold">
                    {metric.available && metric.value !== null
                      ? `${metric.value.toLocaleString('pt-BR')}${metric.unit ? ` ${metric.unit}` : ''}`
                      : 'Indisponível'}
                  </p>
                  {metric.note && (
                    <p className="text-muted mt-2 text-xs">{metric.note}</p>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <p
              role="status"
              className="text-muted bg-sunken rounded-xl p-5 text-sm"
            >
              O provedor não disponibilizou indicadores nesta consulta.
            </p>
          )}
          <p className="text-muted mt-4 text-xs">
            Valores indisponíveis não são contados como zero. Estes indicadores
            não substituem a fatura do provedor.
          </p>
          {data.items.length > 0 && (
            <div className="mt-4">
              <BackendTable
                rows={data.items}
                columns={data.columns}
                caption="Detalhes de uso"
              />
            </div>
          )}
        </>
      )}
    </BackendResource>
  )
}

export function BackendUsers({ projectId }: { projectId: string }) {
  const [offset, setOffset] = useState(0)
  return (
    <BackendResource
      input={{ projectId, operation: 'users', limit: PAGE_SIZE, offset }}
      label="Contas do aplicativo"
    >
      {({ data }) => (
        <>
          <BackendTable
            rows={data.items}
            columns={data.columns}
            caption="Contas do aplicativo"
            empty="Nenhuma conta cadastrada neste projeto."
          />
          <BackendPagination
            offset={offset}
            count={data.items.length}
            limit={PAGE_SIZE}
            hasMore={data.hasMore === true && data.nextOffset !== null}
            onChange={setOffset}
          />
        </>
      )}
    </BackendResource>
  )
}

export function BackendStorage({ projectId }: { projectId: string }) {
  const [offset, setOffset] = useState(0)
  return (
    <BackendResource
      input={{ projectId, operation: 'storage', limit: PAGE_SIZE, offset }}
      label="Espaços de arquivos"
    >
      {({ data }) => (
        <>
          <BackendTable
            rows={data.items}
            columns={data.columns}
            caption="Espaços de arquivos"
            empty="Nenhum espaço de arquivos criado neste projeto."
          />
          <BackendPagination
            offset={offset}
            count={data.items.length}
            limit={PAGE_SIZE}
            hasMore={data.hasMore === true && data.nextOffset !== null}
            onChange={setOffset}
          />
        </>
      )}
    </BackendResource>
  )
}
