'use server'

import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import { requireUser, toActionError } from '@/lib/auth'

/**
 * Gerência dos companions do usuário. Revogar um companion mata a identidade
 * dedicada dele (deleta o usuário Auth próprio → sessões caem) SEM tocar na
 * sessão web do dono. O vínculo vive em companion_devices; o dono só enxerga os
 * próprios (RLS), e a identidade do companion é negada nessa tabela.
 */

export interface CompanionDeviceView {
  id: string
  label: string | null
  lastSeenAt: string | null
  revokedAt: string | null
  createdAt: string
}

export async function listCompanionDevices(): Promise<{
  devices?: CompanionDeviceView[]
  error?: string
}> {
  try {
    const { user, supabase } = await requireUser()
    const { data, error } = await supabase
      .from('companion_devices')
      .select('id, device_label, last_seen_at, revoked_at, created_at')
      .eq('owner_user_id', user.id)
      .order('created_at', { ascending: false })
    if (error) return { error: error.message }
    return {
      devices: (data ?? []).map((d) => ({
        id: d.id as string,
        label: (d.device_label as string | null) ?? null,
        lastSeenAt: (d.last_seen_at as string | null) ?? null,
        revokedAt: (d.revoked_at as string | null) ?? null,
        createdAt: d.created_at as string,
      })),
    }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

export async function revokeCompanionDevice(
  deviceId: string,
): Promise<{ ok?: true; error?: string }> {
  if (!z.string().uuid().safeParse(deviceId).success) {
    return { error: 'ID inválido.' }
  }
  try {
    const { user, supabase } = await requireUser()

    // Só um device do PRÓPRIO dono (RLS + filtro explícito).
    const { data: device } = await supabase
      .from('companion_devices')
      .select('id, auth_user_id')
      .eq('id', deviceId)
      .eq('owner_user_id', user.id)
      .maybeSingle()
    if (!device) return { error: 'Companion não encontrado.' }

    // Marca revogado e apaga a identidade dedicada (mata as sessões dele).
    await supabase
      .from('companion_devices')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', deviceId)
      .eq('owner_user_id', user.id)

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (url && serviceKey) {
      const admin = createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      await admin.auth.admin
        .deleteUser(device.auth_user_id as string)
        .catch(() => {})
    }
    return { ok: true }
  } catch (error) {
    return { error: toActionError(error) }
  }
}
