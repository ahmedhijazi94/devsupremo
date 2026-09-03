'use client'

import { useEffect, useState } from 'react'
import { getProjectChecks } from '@/actions/checks'
import { Pill } from '@/components/ui/pill'

/**
 * O estado dos gates, visível de qualquer lugar do projeto.
 *
 * Fica no cabeçalho e atualiza sozinho: enquanto algo roda, olha de perto (a
 * cada 6s); parado, olha de longe (a cada 30s) — o suficiente para perceber um
 * PR novo começar sem martelar a API do GitHub. Assim o usuário não precisa
 * abrir a aba Testes para saber se está tudo verde.
 */
export function LiveGateBadge({ projectId }: { projectId: string }) {
  const [state, setState] = useState<'idle' | 'pending' | 'passed' | 'failed'>(
    'idle',
  )
  const [label, setLabel] = useState('')

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>

    async function tick() {
      const result = await getProjectChecks(projectId)
      if (!active) return

      if (result.error || !result.data) {
        setState('idle')
        setLabel('')
      } else {
        setState(result.data.state === undefined ? 'idle' : result.data.state)
        setLabel(result.data.summary)
      }

      // Rodando: volta rápido. Assentado: volta devagar, só para pegar um PR
      // novo. O componente vivo evita marteladas na API.
      const next = result.data?.state === 'pending' ? 6000 : 30000
      timer = setTimeout(tick, next)
    }

    tick()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [projectId])

  if (state === 'idle') return null

  const tone = { pending: 'wait', passed: 'up', failed: 'down' } as const

  const text = {
    pending: 'Testes rodando',
    passed: 'Tudo verde',
    failed: 'Gate vermelho',
  }[state]

  return (
    <span title={label}>
      <Pill tone={tone[state]} dot pulse={state === 'pending'}>
        {text}
      </Pill>
    </span>
  )
}
