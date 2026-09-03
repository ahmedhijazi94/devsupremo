import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export type PillTone = 'neutral' | 'up' | 'down' | 'wait' | 'info' | 'ink'

/**
 * Rótulo de estado.
 *
 * A cor carrega significado — verde é bom, âmbar é em andamento, vermelho é
 * ruim — e por isso é separada da cor de ação da interface. Um botão preto
 * e um estado verde nunca competem. `ink` é a exceção deliberada: reservado a
 * marcador de ESTADO ATUAL (ex.: "Ativo" no Histórico de checkpoints), nunca
 * de resultado — por isso fica fora do grupo semântico up/down/wait/info.
 *
 * `icon` e `dot` são OPT-IN (v3.1 finalização — tela do projeto): sem nenhum
 * dos dois, o Pill continua exatamente como antes (só o rótulo colorido — ex.:
 * os cartões de projeto do dashboard). `dot` acrescenta um marcador circular
 * (a cor do tone); `icon` o substitui por um ícone fixo. `pulse` anima o que
 * estiver visível — ping no dot, spin no ícone — pra indicar algo em
 * andamento; sem `dot`/`icon`, `pulse` não tem efeito.
 */
export function Pill({
  tone = 'neutral',
  icon: Icon,
  dot = false,
  pulse = false,
  className,
  children,
  ...props
}: React.ComponentProps<'span'> & {
  tone?: PillTone
  icon?: LucideIcon
  dot?: boolean
  pulse?: boolean
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
        tone === 'neutral' && 'bg-sunken text-ink-soft',
        tone === 'up' && 'bg-up text-up-ink',
        tone === 'down' && 'bg-down text-down-ink',
        tone === 'wait' && 'bg-wait text-wait-ink',
        tone === 'info' && 'bg-info text-info-ink',
        tone === 'ink' && 'bg-ink text-accent-ink',
        className,
      )}
      {...props}
    >
      {Icon ? (
        <Icon className={cn('size-3', pulse && 'animate-spin')} />
      ) : (
        dot && (
          <span className="relative flex size-1.5 shrink-0">
            {pulse && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
            )}
            <span className="relative inline-flex size-1.5 rounded-full bg-current" />
          </span>
        )
      )}
      {children}
    </span>
  )
}
