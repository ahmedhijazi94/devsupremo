import { cn } from '@/lib/utils'

export type PillTone = 'neutral' | 'up' | 'down' | 'wait' | 'info'

/**
 * Rótulo de estado.
 *
 * A cor carrega significado — verde é bom, âmbar é em andamento, vermelho é
 * ruim — e por isso é separada da cor de ação da interface. Um botão preto
 * e um estado verde nunca competem.
 */
export function Pill({
  tone = 'neutral',
  className,
  children,
  ...props
}: React.ComponentProps<'span'> & { tone?: PillTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
        tone === 'neutral' && 'bg-sunken text-ink-soft',
        tone === 'up' && 'bg-up text-up-ink',
        tone === 'down' && 'bg-down text-down-ink',
        tone === 'wait' && 'bg-wait text-wait-ink',
        tone === 'info' && 'bg-info text-info-ink',
        className
      )}
      {...props}
    />
  )
}
