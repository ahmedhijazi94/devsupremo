/**
 * Runtime de desenvolvimento por projeto — a abstração (Fase A).
 *
 * O runtime pertence ao PROJETO, não ao Claude nem ao Codex. Provider é um
 * adapter (Codespaces é o primeiro), para não amarrar o Supremo a um fornecedor.
 * Aqui só o contrato e o modelo; a implementação viva (chamadas à API do
 * GitHub Codespaces, o daemon dentro do ambiente) entra nas fases seguintes,
 * quando a permissão de Codespaces da GitHub App estiver ativa.
 *
 * Regra de ouro do isolamento: o runtime é SEMPRE resolvido a partir do
 * project_id no servidor. Nunca a partir de um codespace_name vindo do cliente.
 */

export type RuntimeStatus =
  | 'offline'
  | 'starting'
  | 'online'
  | 'stopping'
  | 'error'

export type PreviewStatus = 'offline' | 'starting' | 'ready' | 'error'

export type SetupStatus = 'pending' | 'running' | 'ready' | 'setup_failed'

/** Estado do runtime de um projeto, espelho da tabela project_runtimes. */
export interface ProjectRuntime {
  projectId: string
  userId: string
  provider: string
  providerRuntimeId: string | null
  codespaceName: string | null
  status: RuntimeStatus
  previewStatus: PreviewStatus
  previewUrl: string | null
  devPort: number | null
  setupStatus: SetupStatus
  setupError: string | null
  lastActiveAt: string | null
}

/** O que o provedor sabe sobre um ambiente, sem o estado do Supremo. */
export interface RuntimeHandle {
  providerRuntimeId: string
  name: string
  status: RuntimeStatus
}

/** Erros do provedor que a UI e o lifecycle tratam diferente de falha genérica. */
export type RuntimeErrorKind =
  | 'permission' // GitHub App sem a permissão de Codespaces
  | 'quota' // sem cota/indisponível no momento
  | 'not_found' // ambiente sumiu (excluído por fora)
  | 'unavailable' // provedor fora do ar
  | 'unknown'

export class RuntimeError extends Error {
  constructor(
    readonly kind: RuntimeErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'RuntimeError'
  }
}

/**
 * De onde vem o preview de desenvolvimento.
 *
 *  - browser: bundler client-side (Sandpack) no navegador do usuário. Padrão,
 *    custo zero, rápido — mas client-side (não roda o servidor do Next).
 *  - vercel: o deploy atual, comportamento de servidor real. Fallback completo.
 *  - codespace: futuro — dev server real num compute dedicado (opcional/pago).
 */
export type PreviewKind = 'browser' | 'vercel' | 'codespace'

/**
 * Como obter o preview de um projeto. O provider 'browser' é dirigido pelo
 * cliente (sincroniza arquivos via as actions de runtime-sync e monta o bundle
 * no navegador); os demais expõem uma URL externa.
 */
export interface PreviewDescriptor {
  kind: PreviewKind
  /** Para vercel/codespace: a URL a exibir. Para browser: null (é client-side). */
  externalUrl: string | null
  status: PreviewStatus
}

/**
 * Adapter de um provedor de runtime de COMPUTE (Codespaces, VPS, container —
 * futuros). Só lifecycle: o preview 'browser' NÃO implementa isto (é
 * client-side, sem lifecycle de servidor). Genérico de propósito — não é
 * específico de Codespaces.
 *
 * Executar TAREFA dentro de um ambiente de compute é responsabilidade de um
 * daemon do runtime (fase posterior), porque provedores como o GitHub Codespaces
 * não expõem API de execução de comando.
 */
export interface RuntimeProvider {
  readonly name: string
  create(input: {
    repoFullName: string
    branch: string
  }): Promise<RuntimeHandle>
  get(providerRuntimeId: string): Promise<RuntimeHandle | null>
  start(providerRuntimeId: string): Promise<RuntimeHandle>
  stop(providerRuntimeId: string): Promise<void>
  delete(providerRuntimeId: string): Promise<void>
}
