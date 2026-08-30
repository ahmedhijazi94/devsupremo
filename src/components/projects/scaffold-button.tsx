'use client'
import { useFormStatus } from 'react-dom'

export function ScaffoldButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="bg-accent text-accent-ink rounded-[var(--radius-control)] px-6 py-2 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50"
    >
      {pending
        ? 'Provisionando... (isso leva aprox. 1 min)'
        : 'Rodar Scaffolding'}
    </button>
  )
}
