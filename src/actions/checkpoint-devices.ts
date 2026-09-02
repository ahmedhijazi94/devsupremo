'use server'

import { z } from 'zod'
import { requireUser, toActionError } from '@/lib/auth'

/**
 * Gerência das máquinas do checkpoint daemon. Revogar uma máquina invalida na
 * hora o secret dela (o backend recusa todo push-grant/ensure-pr): o daemon
 * daquela máquina para de conseguir empurrar checkpoints, sem tocar em mais nada.
 * O vínculo vive em checkpoint_devices; o dono só enxerga os próprios (RLS).
 */

export interface CheckpointDeviceView {
  id: string
  label: string | null
  lastSeenAt: string | null
  revokedAt: string | null
  createdAt: string
}

export async function listCheckpointDevices(): Promise<{
  devices?: CheckpointDeviceView[]
  error?: string
}> {
  try {
    const { user, supabase } = await requireUser()
    const { data, error } = await supabase
      .from('checkpoint_devices')
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

export async function revokeCheckpointDevice(
  deviceId: string,
): Promise<{ ok?: true; error?: string }> {
  if (!z.string().uuid().safeParse(deviceId).success) {
    return { error: 'ID inválido.' }
  }
  try {
    const { user, supabase } = await requireUser()
    const { data: device } = await supabase
      .from('checkpoint_devices')
      .select('id')
      .eq('id', deviceId)
      .eq('owner_user_id', user.id)
      .maybeSingle()
    if (!device) return { error: 'Máquina não encontrada.' }

    // RLS + filtro explícito: só uma máquina do PRÓPRIO dono é revogada.
    const { error } = await supabase
      .from('checkpoint_devices')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', deviceId)
      .eq('owner_user_id', user.id)
    if (error) return { error: error.message }
    return { ok: true }
  } catch (error) {
    return { error: toActionError(error) }
  }
}
