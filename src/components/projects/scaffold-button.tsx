'use client'
import { useFormStatus } from 'react-dom'

export function ScaffoldButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <button 
      type="submit"
      disabled={disabled || pending}
      className="rounded-lg bg-blue-500 px-6 py-2 text-sm font-bold text-white hover:bg-blue-600 transition-colors disabled:opacity-50"
    >
      {pending ? 'Provisionando... (isso leva aprox. 1 min)' : 'Rodar Scaffolding'}
    </button>
  )
}
