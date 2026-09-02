import { Database, GitPullRequest, History, Sparkles, RotateCcw } from 'lucide-react'
import { formatRelativeTime } from '@/lib/utils'
import { RestoreCheckpointButton } from './restore-checkpoint-button'
import type { CheckpointHistoryItem } from '@/actions/checkpoints'

/**
 * Histórico — cada pedido concluído é um item, com identidade própria (nunca
 * agrupado). O usuário não precisa abrir o GitHub para ver o que mudou ou para
 * voltar a um ponto anterior: status humano, resumo, arquivos/migrations no
 * detalhe, e "Restaurar" cria um pedido (aplicado pelo daemon da máquina
 * original) — nunca um reset. Ver `humanCheckpointStatus`.
 */

const STATUS_STYLE: Record<
  CheckpointHistoryItem['status'],
  { dot: string; label: string }
> = {
  Salvando: { dot: 'bg-line-strong', label: 'Salvando' },
  Publicando: { dot: 'bg-info-ink', label: 'Publicando' },
  Testando: { dot: 'bg-wait-ink', label: 'Testando' },
  Integrado: { dot: 'bg-up-ink', label: 'Integrado' },
  Falhou: { dot: 'bg-down-ink', label: 'Falhou' },
}

const RISK_LABEL: Record<CheckpointHistoryItem['riskLevel'], string> = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
}

interface CheckpointHistoryProps {
  projectId: string
  items: CheckpointHistoryItem[]
}

export function CheckpointHistory({ projectId, items }: CheckpointHistoryProps) {
  if (items.length === 0) {
    return (
      <div className="border-line bg-surface rounded-[var(--radius-inner)] border border-dashed p-6 text-center">
        <History className="text-muted mx-auto mb-2 size-5" />
        <p className="text-muted text-sm">
          Nenhum checkpoint ainda. Cada pedido concluído no seu editor aparece aqui.
        </p>
      </div>
    )
  }

  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => {
        const style = STATUS_STYLE[item.status]
        return (
          <li
            key={item.id}
            className="border-line bg-surface rounded-[var(--radius-inner)] border p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`size-2 shrink-0 rounded-full ${style.dot}`} />
                  <p className="text-ink truncate text-sm font-medium">{item.summary}</p>
                  {item.restoredFromCheckpointId && (
                    <span
                      title="Resultado de uma restauração"
                      className="text-info-ink inline-flex shrink-0 items-center gap-0.5 text-[11px]"
                    >
                      <RotateCcw className="size-3" />
                      restore
                    </span>
                  )}
                </div>
                <div className="text-muted mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span>{style.label}</span>
                  <span>·</span>
                  <span>{formatRelativeTime(item.createdAt)}</span>
                  <span>·</span>
                  <span className="font-mono">{RISK_LABEL[item.riskLevel]}</span>
                  {item.migrations.length > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <Database className="size-3" />
                      {item.migrations.length}{' '}
                      {item.migrations.length === 1 ? 'migration' : 'migrations'}
                    </span>
                  )}
                  {item.prNumber && (
                    <span className="inline-flex items-center gap-1">
                      <GitPullRequest className="size-3" />#{item.prNumber}
                    </span>
                  )}
                </div>
                {item.migrations.length > 0 && item.status !== 'Integrado' && (
                  <p className="text-wait-ink mt-1.5 flex items-center gap-1 text-[11px]">
                    <Sparkles className="size-3" />
                    Este ponto inclui alterações de banco. Restaurar o código não altera
                    o schema; mudanças destrutivas exigem confirmação separada.
                  </p>
                )}
              </div>
              <RestoreCheckpointButton
                projectId={projectId}
                checkpointId={item.id}
                summary={item.summary}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
