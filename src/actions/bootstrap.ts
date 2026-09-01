'use server'

import { headers } from 'next/headers'
import { requireUser } from '@/lib/auth'
import { resolveProject } from '@/lib/mcp/repository'
import { mcpDataClient } from '@/lib/mcp/tokens'
import { approveDeviceGrant, lookupGrant } from '@/lib/bootstrap/codes'
import { supabaseBootstrapStore } from '@/lib/bootstrap/supabase-store'
import { bootstrapCommand } from '@/lib/bootstrap/command'

/**
 * Bootstrap por device flow. O comando local carrega só o project-id (não é
 * segredo) — nada de code temporário no shell history. A autorização acontece
 * aqui, no browser, com o dono autenticado. A checagem de dono usa resolveProject
 * (lança para quem não é dono), nunca um id vindo do client.
 */
async function resolveBaseUrl(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_APP_URL
  if (configured) return configured.replace(/\/$/, '')

  const headersList = await headers()
  const host = headersList.get('host') ?? 'localhost:3000'
  const protocol = host.startsWith('localhost') ? 'http' : 'https'
  return `${protocol}://${host}`
}

/** Monta o comando de bootstrap para o dashboard ("copiar comando"). */
export async function createBootstrapCommand(projectId: string): Promise<
  { command: string; error?: never } | { error: string; command?: never }
> {
  try {
    const { user } = await requireUser()
    await resolveProject(user.id, projectId) // dono? senão lança
    const baseUrl = await resolveBaseUrl()
    return { command: bootstrapCommand(projectId, baseUrl) }
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : 'Falha ao montar o comando.',
    }
  }
}

/**
 * Info do grant pendente, para a página de autorização exibir QUAL projeto está
 * sendo autorizado. Só o dono do projeto enxerga (resolveProject filtra).
 */
export async function getBootstrapGrantInfo(userCode: string): Promise<
  | { projectName: string; status: string; expired: boolean; error?: never }
  | { error: string }
> {
  try {
    const { user } = await requireUser()
    const store = supabaseBootstrapStore(mcpDataClient())
    const grant = await lookupGrant(store, userCode)
    if (!grant) return { error: 'Código não encontrado ou expirado.' }
    // Confirma que o usuário logado é dono do projeto do grant.
    const project = await resolveProject(user.id, grant.projectId)
    return { projectName: project.name, status: grant.status, expired: grant.expired }
  } catch {
    return { error: 'Você não tem acesso a este bootstrap.' }
  }
}

/** Aprova o device flow (o dono autoriza esta máquina a receber a config). */
export async function approveBootstrapDevice(userCode: string): Promise<
  { ok: true; error?: never } | { ok?: never; error: string }
> {
  try {
    const { user } = await requireUser()
    const store = supabaseBootstrapStore(mcpDataClient())
    const grant = await lookupGrant(store, userCode)
    if (!grant) return { error: 'Código não encontrado ou expirado.' }
    // Checagem de dono ANTES de aprovar — resolveProject lança se não for dono.
    await resolveProject(user.id, grant.projectId)

    const approved = await approveDeviceGrant(store, userCode, user.id)
    if (!approved) return { error: 'Código já usado, expirado ou inválido.' }
    return { ok: true }
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : 'Falha ao autorizar o bootstrap.',
    }
  }
}
