import { CheckCircle2, TriangleAlert, HelpCircle } from 'lucide-react'
import { HEALTH_LABEL, type AccountHealth } from '@/lib/account-health'
import { cn } from '@/lib/utils'

export function HealthBadge({ health }: { health: AccountHealth }) {
  const Icon =
    health === 'ok'
      ? CheckCircle2
      : health === 'expired'
        ? TriangleAlert
        : HelpCircle

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs font-medium',
        health === 'ok' && 'text-up-ink',
        health === 'expired' && 'text-wait-ink',
        health === 'unknown' && 'text-muted',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {HEALTH_LABEL[health]}
    </span>
  )
}
