import {
  getGithubCredentials,
  getSupabaseCredentials,
  resolveProject,
} from '@/lib/mcp/repository'
import { getSupabaseAnonKey } from '@/lib/preview'
import type { BootstrapScope } from './codes'
import { resolveCloneToken } from './git-clone-token'

/**
 * Config entregue à máquina local após um resgate de bootstrap válido.
 *
 * PRINCÍPIO DE MENOR PRIVILÉGIO:
 *   • env só com NEXT_PUBLIC_ (públicas por design — vão ao bundle de qualquer
 *     forma). NUNCA service_role aqui.
 *   • gitToken é de curta duração (renovado pelo refresh), só pro clone.
 *   • nada disto entra no Git (o .env.local é gitignored) nem em log.
 */
export interface BootstrapConfig {
  project: {
    id: string
    name: string
    capabilities: string[]
    scaffoldVersion: string | null
    securityProfile: string | null
  }
  repo: { url: string; fullName: string; branch: string }
  /** Token curto só pro clone. Repo-scoped (installation) quando possível. */
  gitToken: string
  /** Origem do token de clone, para observabilidade (sem revelar o valor). */
  gitTokenScope: 'installation' | 'user'
  /** Só variáveis públicas (NEXT_PUBLIC_…). */
  env: Record<string, string>
}

export async function resolveBootstrapConfig(
  scope: BootstrapScope,
): Promise<BootstrapConfig> {
  // resolveProject filtra pelo dono — projeto de outro usuário nem aparece.
  const project = await resolveProject(scope.userId, scope.projectId)
  const gh = await getGithubCredentials(scope.userId, project)

  // Token de clone: installation token repo-scoped se o App estiver configurado;
  // senão, o token user-to-server (fallback). Só entregue pelo canal seguro.
  const clone = await resolveCloneToken(project, async () => gh.token)

  // Env PÚBLICAS do projeto (Supabase URL + anon). Best-effort: sem Supabase
  // vinculado, o app sobe sem elas (e avisa).
  const env: Record<string, string> = {}
  try {
    const supa = await getSupabaseCredentials(scope.userId, project)
    env.NEXT_PUBLIC_SUPABASE_URL = `https://${supa.projectRef}.supabase.co`
    const anon = await getSupabaseAnonKey(supa.token, supa.projectRef)
    if (anon) env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anon
  } catch {
    // projeto sem Supabase: segue sem as env públicas do backend
  }

  const row = project as unknown as Record<string, unknown>
  return {
    project: {
      id: project.id,
      name: project.name,
      capabilities: Array.isArray(row.capabilities)
        ? (row.capabilities as string[])
        : [],
      scaffoldVersion: (row.scaffold_version as string | null) ?? null,
      securityProfile: (row.security_profile as string | null) ?? null,
    },
    repo: {
      url: `https://github.com/${gh.repoFullName}.git`,
      fullName: gh.repoFullName,
      branch: gh.branch,
    },
    gitToken: clone.token,
    gitTokenScope: clone.scope,
    env,
  }
}
