import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { mcpDataClient } from '@/lib/mcp/tokens'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { supabaseCheckpointDeviceStore, getLatestKnownCheckpoint } from '@/lib/checkpoint/store'

/**
 * Sincronização entre máquinas (v3.3) — checagem LEVE do estado remoto mais
 * recente CONHECIDO de um projeto, pra retomada de sessão numa máquina que
 * pode estar atrasada. Só um SELECT no banco (nunca GitHub) — nada de build,
 * teste, install ou operação pesada. O "mais recente" já cobre um checkpoint
 * publicado que ainda está em PR/CI (não só o que já chegou na `main`) —
 * reaproveita a MESMA query/estado que o publish usa pra proteção cross-
 * machine (`getLatestKnownCheckpoint`), nunca um segundo sistema de versão.
 *
 * Mesmo padrão de auth de `/restore-poll`: device secret, dono do projeto.
 * Nenhuma credencial GitHub aqui — não precisa (não fala com o GitHub).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  deviceSecret: z.string().min(10),
  projectId: z.string().uuid(),
})

export async function POST(request: NextRequest): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'payload inválido.' }, { status: 400 })
  const body = parsed.data
  const client = mcpDataClient()

  const auth = await authenticateDeviceSecret(
    supabaseCheckpointDeviceStore(client),
    body.deviceSecret,
  )
  if (!auth.ok) return Response.json({ error: 'device não autorizado.' }, { status: 401 })

  // O device precisa ser do DONO do projeto (mesma checagem do publish/restore-poll).
  const { data: proj } = await client
    .from('projects')
    .select('id, user_id')
    .eq('id', body.projectId)
    .maybeSingle()
  if (!proj || (proj.user_id as string) !== auth.device.ownerUserId) {
    // Fail-closed sem vazar se o projeto existe: mesmo formato de "nada aqui".
    return Response.json({ latest: null })
  }

  const latest = await getLatestKnownCheckpoint(client, body.projectId)
  return Response.json({
    latest: latest && {
      id: latest.id,
      createdAt: latest.createdAt,
      summary: latest.summary,
      pushStatus: latest.pushStatus,
      integrationStatus: latest.integrationStatus,
      prNumber: latest.prNumber,
      // v3.3: continuidade entre máquinas nunca espera o CI/merge — a
      // branch real já gerenciada pelo Supremo (existe assim que
      // push_status chega a 'published') é base válida por si só.
      integrationBranch: latest.integrationBranch,
      // v3.3 (ajuste): SHA exato deste checkpoint em integrationBranch — o
      // client pina o fast-forward nele (nunca no tip móvel da branch), pra
      // nunca pousar num checkpoint mais novo publicado por outra máquina
      // durante a corrida (ver sync.ts).
      publishedSha: latest.publishedSha,
    },
  })
}
