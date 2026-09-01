import type { Capability, CapabilityId } from './types'

/**
 * Registry das capabilities. Só entram aqui as IMPLEMENTADAS de verdade. As
 * planejadas (admin, webhooks, payments, ai, rag) ficam com `implemented:false`
 * pra a arquitetura tê-las como destino sem prometer o que não existe.
 *
 * Regra: capability desligada não contribui NADA. Portanto tudo que a
 * capability adiciona está declarado aqui, e o resolver só materializa o que
 * foi pedido (+ dependências).
 */
export const CAPABILITIES: Record<CapabilityId, Capability> = {
  auth: {
    id: 'auth',
    title: 'Auth',
    description:
      'Login, sessão, logout, refresh, middleware e proteção de rotas com Supabase Auth.',
    implemented: true,
    envVars: [
      {
        name: 'NEXT_PUBLIC_SUPABASE_URL',
        description: 'URL do projeto Supabase.',
        public: true,
        autoProvisioned: true,
      },
      {
        name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
        description: 'Chave pública (anon/publishable) do Supabase.',
        public: true,
        autoProvisioned: true,
      },
    ],
    securityChecks: ['rls', 'authorization'],
    securityInvariants: [
      'Toda tabela privada deve ter RLS com auth.uid() — nunca user_id vindo do client.',
      'Autorização é server-side; esconder botão no front não é autorização.',
    ],
  },

  multitenant: {
    id: 'multitenant',
    title: 'Multi-Tenant',
    description:
      'Organizations/workspaces com isolamento por tenant garantido via RLS.',
    implemented: true,
    dependsOn: ['auth'],
    securityChecks: ['tenant-isolation', 'idor'],
    securityInvariants: [
      'Tenant A NUNCA acessa dado de Tenant B (list, get-by-id, update, delete, export).',
      'Toda query privada é escopada por tenant no servidor, não no client.',
    ],
  },

  storage: {
    id: 'storage',
    title: 'Storage',
    description:
      'Upload/download de arquivos com Supabase Storage e policies de acesso.',
    implemented: true,
    dependsOn: ['auth'],
    securityChecks: ['storage-policies', 'idor'],
    securityInvariants: [
      'Buckets privados têm policy — objeto de um usuário não vaza para outro.',
      'URLs assinadas são curtas; nada de bucket público por conveniência.',
    ],
  },

  // ── Planejadas (cabem na arquitetura; ainda não implementadas) ──
  admin: {
    id: 'admin',
    title: 'Admin',
    description: 'Papéis/permissões e área administrativa. (planejada)',
    implemented: false,
    dependsOn: ['auth'],
    securityChecks: ['authorization', 'idor'],
  },
  webhooks: {
    id: 'webhooks',
    title: 'Webhooks',
    description: 'Recebimento de webhooks com validação de assinatura. (planejada)',
    implemented: false,
    securityChecks: ['webhook-signature', 'secrets'],
  },
  payments: {
    id: 'payments',
    title: 'Payments',
    description: 'Integração de pagamentos. (planejada)',
    implemented: false,
    dependsOn: ['auth'],
    securityChecks: ['secrets', 'authorization'],
  },
  ai: {
    id: 'ai',
    title: 'AI',
    description: 'Recursos de IA no app gerado. (planejada)',
    implemented: false,
    securityChecks: ['secrets'],
  },
  rag: {
    id: 'rag',
    title: 'RAG',
    description:
      'Conhecimento por IA com isolamento de documento/tenant. (planejada, NÃO nesta refatoração)',
    implemented: false,
    dependsOn: ['auth', 'ai'],
    securityChecks: ['tenant-isolation', 'idor'],
  },
}

/** Ids de capabilities implementadas (as que a UI deve oferecer). */
export const IMPLEMENTED_CAPABILITY_IDS = (
  Object.keys(CAPABILITIES) as CapabilityId[]
).filter((id) => CAPABILITIES[id].implemented)
