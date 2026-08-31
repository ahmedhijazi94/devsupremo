'use server'

import { z } from 'zod'
import { requireProjectOwner, toActionError } from '@/lib/auth'
import { decryptToken } from '@/lib/crypto'
import { setEnvironmentVariables } from '@/lib/vercel'

/**
 * Pedidos de secret: o agente pede uma env var, o dono preenche aqui, e o valor
 * vai DIRETO para a Vercel — nunca é gravado no Supremo nem visto pelo agente.
 *
 * É o padrão certo de credencial: quem digita o segredo é o dono, no próprio
 * campo; o Supremo só faz a ponte para a env var encriptada da Vercel. O código
 * do app lê com process.env.NOME em tempo de execução.
 */

const PROJECT_COLUMNS =
  'id, user_id, vercel_account_id, vercel_project_id'

const envName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Nome de env var inválido.')

export interface SecretRequestView {
  name: string
  description: string | null
  isSecret: boolean
  status: 'pending' | 'fulfilled'
}

export async function getSecretRequests(
  projectId: string,
): Promise<{ requests?: SecretRequestView[]; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) {
    return { error: 'ID inválido.' }
  }

  try {
    const { supabase } = await requireProjectOwner(projectId, 'id, user_id')

    const { data, error } = await supabase
      .from('secret_requests')
      .select('name, description, is_secret, status')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true })

    if (error) return { error: error.message }

    return {
      requests: (data ?? []).map((row) => ({
        name: row.name as string,
        description: (row.description as string | null) ?? null,
        isSecret: (row.is_secret as boolean) ?? true,
        status: (row.status as 'pending' | 'fulfilled') ?? 'pending',
      })),
    }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

/**
 * Salva o valor na env var da Vercel e marca o pedido como atendido. O valor
 * some daqui assim que sai para a Vercel — nunca toca o banco do Supremo nem o
 * log (só o NOME é auditado).
 */
export async function saveSecret(input: {
  projectId: string
  name: string
  value: string
}): Promise<{ ok?: true; error?: string }> {
  const parsed = z
    .object({
      projectId: z.string().uuid(),
      name: envName,
      value: z.string().min(1),
    })
    .safeParse(input)
  if (!parsed.success) return { error: 'Dados inválidos.' }

  const { projectId, name, value } = parsed.data

  try {
    const { user, supabase, project } = await requireProjectOwner(
      projectId,
      PROJECT_COLUMNS,
    )

    const vercelProjectId = project.vercel_project_id as string | null
    const accountId = project.vercel_account_id as string | null
    if (!vercelProjectId || !accountId) {
      return {
        error:
          'Projeto sem Vercel vinculada — conecte a Vercel para guardar o secret.',
      }
    }

    const { data: account } = await supabase
      .from('vercel_accounts')
      .select('access_token_encrypted, team_id')
      .eq('id', accountId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!account) return { error: 'Conta Vercel não encontrada.' }

    const token = decryptToken(account.access_token_encrypted as string)
    const teamId = (account.team_id as string | null) ?? null

    // Aqui o valor sai do Supremo para a Vercel (encriptado, se não NEXT_PUBLIC_).
    await setEnvironmentVariables(token, teamId, vercelProjectId, {
      [name]: value,
    })

    await supabase
      .from('secret_requests')
      .update({ status: 'fulfilled', fulfilled_at: new Date().toISOString() })
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .eq('name', name)

    // Auditoria com o NOME, jamais o valor.
    await supabase.from('audit_logs').insert({
      user_id: user.id,
      action: 'secret.save',
      resource_type: 'project',
      resource_id: projectId,
      metadata: { name },
      ip_address: null,
    })

    return { ok: true }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

export async function dismissSecretRequest(input: {
  projectId: string
  name: string
}): Promise<{ ok?: true; error?: string }> {
  const parsed = z
    .object({ projectId: z.string().uuid(), name: envName })
    .safeParse(input)
  if (!parsed.success) return { error: 'Dados inválidos.' }

  try {
    const { user, supabase } = await requireProjectOwner(
      parsed.data.projectId,
      'id, user_id',
    )
    await supabase
      .from('secret_requests')
      .delete()
      .eq('project_id', parsed.data.projectId)
      .eq('user_id', user.id)
      .eq('name', parsed.data.name)
    return { ok: true }
  } catch (error) {
    return { error: toActionError(error) }
  }
}
