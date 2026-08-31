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
 * Adapter de um provedor de runtime (Codespaces, e futuros). Só lifecycle e
 * descoberta — executar TAREFA dentro do ambiente é responsabilidade do daemon
 * do runtime (fase posterior), porque o GitHub não expõe API de execução de
 * comando num Codespace.
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
