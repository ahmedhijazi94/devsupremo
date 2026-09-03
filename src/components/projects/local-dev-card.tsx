'use client'

import { useState } from 'react'
import { Copy, Check, TerminalSquare } from 'lucide-react'

/**
 * "Desenvolvimento Local" — a única ação que o usuário precisa quando o projeto
 * está READY. Copia UM comando; o resto (autorizar no browser, clonar, env,
 * instalar, baseline) acontece sozinho pelo device flow do CLI. O comando só
 * carrega o project-id (não é segredo).
 */
export function LocalDevCard({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard bloqueado: o usuário seleciona e copia manualmente
    }
  }

  return (
    <section className="bg-surface rounded-[var(--radius-inner)] p-4 sm:p-5">
      <div className="mb-3.5 flex items-start gap-2.5">
        <div className="bg-sunken flex size-7 shrink-0 items-center justify-center rounded-full">
          <TerminalSquare className="text-ink-soft size-3.5" />
        </div>
        <div className="min-w-0 pt-0.5">
          <h2 className="text-ink text-sm font-semibold">Desenvolvimento Local</h2>
          <p className="text-muted mt-0.5 text-xs leading-relaxed">
            Cole no terminal e autorize no navegador. O workspace clona, configura o{' '}
            <code>.env.local</code>, instala e roda o baseline sozinho. Depois:{' '}
            <span className="text-ink font-mono">npm run dev</span>.
          </p>
        </div>
      </div>

      <div className="bg-sunken flex items-start gap-2 rounded-[var(--radius-control)] p-2.5">
        <code className="text-ink min-w-0 flex-1 break-all font-mono text-xs">
          {command}
        </code>
        <button
          onClick={copy}
          title="Copiar comando"
          className="text-muted hover:text-ink shrink-0 transition-colors"
        >
          {copied ? (
            <Check className="text-up-ink h-4 w-4" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </button>
      </div>

      <p className="text-muted mt-2.5 text-xs">
        Sem segredo no comando — a autorização é no navegador, por dispositivo, e
        revogável.
      </p>
    </section>
  )
}
