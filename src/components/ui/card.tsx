import { cn } from '@/lib/utils'

/**
 * Cartão — a unidade de composição da interface.
 *
 * Superfície clara sobre o fundo, canto generoso, sem borda: a separação
 * vem do contraste de superfície, não de um traço. Borda só quando o cartão
 * precisa se destacar do que está atrás dele.
 */
export function Card({ className, ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      className={cn('bg-surface rounded-[var(--radius-card)] p-6', className)}
      {...props}
    />
  )
}

/** Cartão dentro de cartão: um degrau mais fundo, canto menor. */
export function CardInner({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('bg-sunken rounded-[var(--radius-inner)] p-5', className)}
      {...props}
    />
  )
}

export function CardTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return (
    <h2
      className={cn('text-base font-semibold tracking-tight', className)}
      {...props}
    />
  )
}

export function CardNote({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cn('text-muted text-sm', className)} {...props} />
}

/**
 * Número grande como âncora do cartão.
 *
 * O valor vem antes do rótulo na hierarquia visual porque é o que se procura
 * ao bater o olho; o rótulo só desambigua depois.
 */
export function Stat({
  label,
  value,
  delta,
  icon,
  footer,
}: {
  label: string
  value: React.ReactNode
  delta?: { value: string; direction: 'up' | 'down' | 'flat' }
  icon?: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-3">
          <p className="text-muted text-sm">{label}</p>
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="tabular text-4xl font-semibold tracking-tight">
              {value}
            </span>
            {delta && <Delta {...delta} />}
          </div>
        </div>

        {icon && (
          <span className="bg-sunken text-ink-soft flex h-11 w-11 shrink-0 items-center justify-center rounded-full">
            {icon}
          </span>
        )}
      </div>

      {footer && <div className="mt-auto pt-4">{footer}</div>}
    </Card>
  )
}

export function Delta({
  value,
  direction,
}: {
  value: string
  direction: 'up' | 'down' | 'flat'
}) {
  return (
    <span
      className={cn(
        'tabular inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
        direction === 'up' && 'bg-up text-up-ink',
        direction === 'down' && 'bg-down text-down-ink',
        direction === 'flat' && 'bg-sunken text-muted',
      )}
    >
      {value}
    </span>
  )
}
