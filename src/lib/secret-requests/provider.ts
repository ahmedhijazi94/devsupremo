import { z } from 'zod'
import type { SecretBinding } from './policy'
import { boundedJson } from '@/lib/database-inspection/provider'
import { SecretRequestError } from './policy'
import { createHash } from 'node:crypto'
import { parseSupabaseSecretMetadata } from '../supabase/secret-metadata'

/** The response can contain the value: consume only bounded status information, never return/log it. */
export async function deliverSecret(binding: SecretBinding, name: string, value: string, token: string, teamId: string | null, authorize?:()=>Promise<void>): Promise<void> {
  const url = binding.target === 'supabase'
    ? new URL(`https://api.supabase.com/v1/projects/${encodeURIComponent(binding.targetRef)}/secrets`)
    : new URL(`https://api.vercel.com/v10/projects/${encodeURIComponent(binding.targetRef)}/env`)
  if (binding.target === 'vercel') {
    url.searchParams.set('upsert', 'true')
    if (teamId) url.searchParams.set('teamId', teamId)
  }
  const payload = binding.target === 'supabase' ? [{ name, value }] : { key: name, value, type: 'encrypted', target: [binding.environment] }
  try {
    await authorize?.()
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error('Provider rejected secret')
    if (binding.target === 'vercel') {
      const result = await boundedJson(response, 64000)
      const created = z.object({ id: z.string().min(1), key: z.literal(name), type: z.literal('encrypted'), target: z.tuple([z.literal(binding.environment)]) })
      const confirmation = z.object({ created: z.union([created, z.tuple([created])]), failed: z.array(z.unknown()).max(0).optional() }).safeParse(result)
      if (!confirmation.success) throw new Error('Provider did not confirm the named secret and exact environment')
    } else {
      await response.body?.cancel()
      await authorize?.()
      const observed=await fetch(url,{method:'GET',headers:{Authorization:`Bearer ${token}`},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)})
      if(!observed.ok){await observed.body?.cancel();throw new Error('Secret readback failed')}
      const metadata=parseSupabaseSecretMetadata(await boundedJson(observed,64000))
      if(metadata?.find(item=>item.name===name)?.digest!==createHash('sha256').update(value).digest('hex'))throw new Error('Secret fingerprint not confirmed')
    }
  } catch { throw new SecretRequestError('O provedor não confirmou o envio do secret. O pedido permanece pendente; verifique a conexão e tente novamente.') }
}
