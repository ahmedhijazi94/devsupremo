import { z } from 'zod'

/**
 * Protocolo Supremo ↔ Companion (canal seguro, ver runtime-architecture.md).
 *
 * O contrato vive aqui (e não só no companion) porque o Supremo web/MCP é quem
 * MANDA os comandos e VALIDA as respostas — mesma fonte da verdade, sem
 * divergir. O companion implementa o outro lado.
 *
 * Princípio central: a edição do agente vai DIRETO ao filesystem local
 * (apply_edits) → HMR → preview imediato. GitHub está fora do caminho crítico:
 * clone/pull é só bootstrap; commit/push é assíncrono (git_sync).
 *
 * Segurança do protocolo: nenhuma mensagem carrega token de admin/service_role.
 * O companion age só no projeto do comando, cujo dono o servidor já resolveu.
 */

// ── Comandos: Supremo → companion ──────────────────────────────

/** Prepara o workspace e sobe o dev server. Idempotente: se já rodando, reusa. */
const startProject = z.object({
  type: z.literal('start_project'),
  projectId: z.string().uuid(),
  repoFullName: z.string().min(1),
  branch: z.string().min(1),
  // Credencial de curta duração só para o clone/pull. Nunca um token de admin.
  cloneToken: z.string().min(1).optional(),
})

/** Para o dev server e libera a porta. Não apaga o workspace. */
const stopProject = z.object({
  type: z.literal('stop_project'),
  projectId: z.string().uuid(),
})

/** Edição DIRETA no filesystem local (o caminho rápido). content:null apaga. */
const applyEdits = z.object({
  type: z.literal('apply_edits'),
  projectId: z.string().uuid(),
  edits: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string().nullable(),
      }),
    )
    .min(1),
})

/** Roda validação local em background (não bloqueia). */
const runValidation = z.object({
  type: z.literal('run_validation'),
  projectId: z.string().uuid(),
  kind: z.enum(['fast', 'full']),
})

/** Commit + push — assíncrono, fora do caminho crítico da edição. */
const gitSync = z.object({
  type: z.literal('git_sync'),
  projectId: z.string().uuid(),
  message: z.string().min(1),
})

export const CompanionCommand = z.discriminatedUnion('type', [
  startProject,
  stopProject,
  applyEdits,
  runValidation,
  gitSync,
])
export type CompanionCommand = z.infer<typeof CompanionCommand>

// ── Eventos: companion → Supremo ───────────────────────────────

export const RUNTIME_STATUS = [
  'offline',
  'preparing', // clone/pull + install
  'starting', // subindo o dev server
  'online',
  'error',
] as const

/** Estado do runtime/preview do projeto. */
const runtimeStatus = z.object({
  type: z.literal('runtime_status'),
  projectId: z.string().uuid(),
  status: z.enum(RUNTIME_STATUS),
  previewUrl: z.string().nullable().optional(),
  devPort: z.number().int().positive().nullable().optional(),
  detail: z.string().optional(),
})

/** Preview pronto: a URL local que o navegador do dev vai abrir. */
const previewReady = z.object({
  type: z.literal('preview_ready'),
  projectId: z.string().uuid(),
  url: z.string().min(1),
  port: z.number().int().positive(),
})

/** Linha de log do install/dev/teste — o companion joga throttled. */
const logLine = z.object({
  type: z.literal('log'),
  projectId: z.string().uuid(),
  stream: z.enum(['install', 'dev', 'validation']),
  line: z.string(),
})

/** Resultado resumido de validação (o log completo fica no companion). */
const validationResult = z.object({
  type: z.literal('validation_result'),
  projectId: z.string().uuid(),
  kind: z.enum(['fast', 'full']),
  status: z.enum(['passed', 'failed']),
  revision: z.string().nullable(),
  summary: z.string(),
})

const runtimeError = z.object({
  type: z.literal('error'),
  projectId: z.string().uuid().nullable(),
  kind: z.enum(['clone', 'install', 'dev', 'validation', 'unknown']),
  message: z.string(),
})

export const CompanionEvent = z.discriminatedUnion('type', [
  runtimeStatus,
  previewReady,
  logLine,
  validationResult,
  runtimeError,
])
export type CompanionEvent = z.infer<typeof CompanionEvent>

/** Parse defensivo — o outro lado do canal é código nosso, mas nunca confie cru. */
export function parseCommand(raw: unknown): CompanionCommand | null {
  const result = CompanionCommand.safeParse(raw)
  return result.success ? result.data : null
}

export function parseEvent(raw: unknown): CompanionEvent | null {
  const result = CompanionEvent.safeParse(raw)
  return result.success ? result.data : null
}
