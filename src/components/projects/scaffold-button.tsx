'use client'
import { useFormStatus } from 'react-dom'

export function ScaffoldButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="rounded-[var(--radius-control)] bg-blue-500 px-6 py-2 text-sm font-bold text-white transition-colors hover:bg-blue-600 disabled:opacity-50"
    >
      {pending
        ? 'Provisionando... (isso leva aprox. 1 min)'
        : 'Rodar Scaffolding'}
    </button>
  )
}
