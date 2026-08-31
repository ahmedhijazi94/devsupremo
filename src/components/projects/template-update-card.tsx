'use client'

import { useState } from 'react'
import { ArrowUpCircle, Loader2, GitPullRequest, Check } from 'lucide-react'
import {
  getTemplateSyncStatus,
  applyTemplateSync,
  type TemplateSyncStatus,
  type TemplateSyncResult,
} from '@/actions/template-sync'

/**
 * A ponte entre o template que evolui e um projeto que já existe. Consertos que
 * vivem nos rails — cookies do preview, inspector, CI — chegam aqui sem recriar
 * o projeto. Só aparece quando a base grava uma versão atrás da atual.
 *
 * Confere sob demanda (não a cada load: são leituras do GitHub) e aplica como
 * PR pelos gates. O que muda é sempre rail; a funcionalidade do app fica intacta.
 */
export function TemplateUpdateCard({
  projectId,
  projectVersion,
  latestVersion,
}: {
  projectId: string
  projectVersion: string | null
  latestVersion: string
}) {
  const [status, setStatus] = useState<TemplateSyncStatus | null>(null)
  const [result, setResult] = useState<TemplateSyncResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function check() {
    setBusy(true)
    setError(null)
    const res = await getTemplateSyncStatus(projectId)
    setBusy(false)
    if (res.error) setError(res.error)
    else if (res.status) setStatus(res.status)
  }

  async function apply() {
    setBusy(true)
    setError(null)
    const res = await applyTemplateSync(projectId)
    setBusy(false)
    if (res.error) setError(res.error)
    else if (res.upToDate) setStatus((s) => (s ? { ...s, upToDate: true } : s))
    else if (res.result) setResult(res.result)
  }

  // Já abriu o PR — o trabalho passou para os gates.
  if (result) {
    return (
      <Shell>
        <div className="flex items-start gap-2">
          <GitPullRequest className="text-up-ink mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium">PR de atualização aberto</p>
            <p className="text-muted mt-1 text-xs">
              {result.updated.length} rails atualizados
              {result.created.length > 0 &&
                `, ${result.created.length} criados`}
              . Os gates estão rodando — revise e faça o merge.
            </p>
            <a
              href={result.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent mt-2 inline-flex items-center gap-1 text-xs font-medium hover:underline"
            >
              Abrir PR #{result.prNumber}
            </a>
          </div>
        </div>
      </Shell>
    )
  }

  // Conferiu e o repo já bate com o template atual.
  if (status?.upToDate) {
    return (
      <Shell>
        <p className="text-muted flex items-center gap-2 text-xs">
          <Check className="text-up-ink h-4 w-4 shrink-0" />
          Base em dia com o template {latestVersion}.
        </p>
      </Shell>
    )
  }

  return (
    <Shell>
      <div className="flex items-start gap-2">
        <ArrowUpCircle className="text-accent mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Atualização de base</p>
          <p className="text-muted mt-1 text-xs">
            {versionLabel(projectVersion)} → template {latestVersion}. Traz os
            consertos de infra sem recriar o projeto nem tocar na funcionalidade.
          </p>

          {status && !status.upToDate && (
            <div className="text-muted mt-2 space-y-0.5 text-xs">
              {status.updates.length > 0 && (
                <p>{status.updates.length} arquivos de base atualizados</p>
              )}
              {status.creates.length > 0 && (
                <p>{status.creates.length} arquivos criados</p>
              )}
              {status.skipped > 0 && (
                <p>{status.skipped} arquivos do app preservados</p>
              )}
            </div>
          )}

          {error && <p className="text-down-ink mt-2 text-xs">{error}</p>}

          <div className="mt-3">
            {status ? (
              <button
                onClick={apply}
                disabled={busy}
                className="bg-accent text-accent-ink inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <GitPullRequest className="h-3.5 w-3.5" />
                )}
                Abrir PR de atualização
              </button>
            ) : (
              <button
                onClick={check}
                disabled={busy}
                className="bg-surface text-ink inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-80 disabled:opacity-60"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Ver o que muda
              </button>
            )}
          </div>
        </div>
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="bg-surface rounded-[var(--radius-inner)] p-4">
      {children}
    </section>
  )
}

function versionLabel(version: string | null): string {
  return version ? `Base ${version}` : 'Base antiga'
}
