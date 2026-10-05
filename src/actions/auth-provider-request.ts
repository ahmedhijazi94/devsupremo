'use server'

import { z } from 'zod'
import { requireProjectOwner } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/admin'
import { authProviderConfigurationSchema, secretEntrySchema } from '@/lib/secret-requests/contract'
import { sameSecretConfiguration, safeSecretFailure, SecretRequestError, type SecretRequestErrorCode } from '@/lib/secret-requests/policy'
import { requestSecrets } from '@/lib/secret-requests/service'
import { secretRequestStore } from '@/lib/secret-requests/store'

const inputSchema = authProviderConfigurationSchema.omit({ kind: true }).extend({
  projectId: z.string().uuid(), expectedRef: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  environment: z.enum(['development', 'production']),
}).strict()
export type AuthProviderRequestInput = z.infer<typeof inputSchema>

/** Creates metadata only. The owner supplies the value through saveSecret. */
export async function requestAuthProvider(input: AuthProviderRequestInput): Promise<{
  ok?: true; requestId?: string; status?: 'pending' | 'fulfilled'; error?: string; errorCode?: SecretRequestErrorCode
}> {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) return { error: 'Informe provedor, Client ID e ambiente válidos.' }
  try {
    const { projectId, expectedRef, environment, provider, clientId } = parsed.data
    const { user } = await requireProjectOwner(projectId, 'id,user_id')
    const port = secretRequestStore(createServiceClient(), user.id, projectId)
    const entry = secretEntrySchema.parse({
      name: `AUTH_${provider.toUpperCase()}_CLIENT_SECRET`,
      description: `Configurar login com ${provider === 'google' ? 'Google' : 'GitHub'} no Supabase pelo formulário seguro.`,
      target: 'supabase', environment, configuration: { kind: 'supabase-auth-provider', provider, clientId },
    })
    const requests = await requestSecrets({ ...port, resolve: async target => {
      const binding = await port.resolve(target)
      if (binding.targetRef !== expectedRef || binding.environment !== environment || binding.target !== 'supabase')
        throw new SecretRequestError('O vínculo do banco mudou. Atualize o painel antes de preparar o campo seguro.')
      return binding
    } }, [entry])
    const selected = requests.filter(request => request.name === entry.name && request.target === 'supabase'
      && request.environment === environment && request.targetRef === expectedRef && sameSecretConfiguration(request.configuration, entry.configuration))
    if (selected.length !== 1) throw new SecretRequestError('O pedido salvo não corresponde à configuração solicitada.')
    return { ok: true, requestId: selected[0]!.id, status: selected[0]!.status }
  } catch (error) { return safeSecretFailure(error) }
}
