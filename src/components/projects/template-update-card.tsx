'use client'

import { useEffect, useState } from 'react'
import { ArrowUpCircle, Loader2, GitPullRequest } from 'lucide-react'
import {
  getTemplateSyncStatus,
  applyTemplateSync,
  type TemplateSyncStatus,
  type TemplateSyncResult,
} from '@/actions/template-sync'

/**
 * A ponte entre o template que evolui e um projeto que já existe. Consertos que
 * vivem nos rails — cookies do preview, inspector, CI — chegam aqui sem recriar
 * o projeto.
 *
 * Confere de verdade ao abrir (uma chamada só, comparando sha do git) e some
 * quando o projeto já está no template atual — mesmo que a versão gravada ainda
 * dissesse o contrário. Aplicar é um PR pelos gates; a funcionalidade do app
 * fica intacta.
 */
type Phase = 'checking' | 'behind' | 'uptodate' | 'error' | 'done'

export function TemplateUpdateCard({
  projectId,
  projectVersion,
  latestVersion,
}: {
  projectId: string
  projectVersion: string | null
  latestVersion: string
}) {
  const [phase, setPhase] = useState<Phase>('checking')
  const [status, setStatus] = useState<TemplateSyncStatus | null>(null)
  const [result, setResult] = useState<TemplateSyncResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Ao abrir, confere o estado real. Se já está em dia, o cartão some (e a ação
  // reconcilia a versão gravada, então nas próximas vezes nem confere).
  useEffect(() => {
    let active = true
    getTemplateSyncStatus(projectId).then((res) => {
      if (!active) return
      if (res.error) {
        setError(res.error)
        setPhase('error')
      } else if (res.status?.upToDate) {
        setPhase('uptodate')
      } else if (res.status) {
        setStatus(res.status)
        setPhase('behind')
      }
    })
    return () => {
      active = false
    }
  }, [projectId])

  async function apply() {
    setBusy(true)
    setError(null)
    const res = await applyTemplateSync(projectId)
    setBusy(false)
    if (res.error) setError(res.error)
    else if (res.upToDate) setPhase('uptodate')
    else if (res.result) {
      setResult(res.result)
      setPhase('done')
    }
  }

  // Em dia (ou ainda conferindo): nada na tela. É o que o usuário pediu —
  // projeto atualizado não mostra "Atualização de base".
  if (phase === 'checking' || phase === 'uptodate') return null

  if (phase === 'error') {
    return (
      <Shell>
        <p className="text-muted text-xs">
          Não deu para checar a base agora
          {error ? `: ${error}` : '.'}
        </p>
      </Shell>
    )
  }

  if (phase === 'done' && result) {
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

  // phase === 'behind'
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

          {status && (
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

          {status?.openPr ? (
            // Já existe um PR aberto: o próximo passo é o MERGE, não reabrir.
            <div className="mt-3">
              <p className="text-muted text-xs">
                PR #{status.openPr.number} já aberto. Falta só o merge — quando
                os gates ficarem verdes, mescle para a base entrar no ar.
              </p>
              <a
                href={status.openPr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent mt-2 inline-flex items-center gap-1 text-xs font-medium hover:underline"
              >
                <GitPullRequest className="h-3.5 w-3.5" />
                Revisar e mesclar o PR #{status.openPr.number}
              </a>
            </div>
          ) : (
            <button
              onClick={apply}
              disabled={busy}
              className="bg-accent text-accent-ink mt-3 inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <GitPullRequest className="h-3.5 w-3.5" />
              )}
              Abrir PR de atualização
            </button>
          )}
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
