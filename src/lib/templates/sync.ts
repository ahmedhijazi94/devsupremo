import type { GithubCredentials } from '@/lib/mcp/repository'
import type { FileChange } from '@/lib/mcp/github'
import { listTree, readFile } from '@/lib/mcp/github'
import {
  buildProjectFiles,
  isManagedPath,
  type FileEntry,
  type TemplateOptions,
} from './project-files'

/**
 * Atualizar a base de um projeto que já existe para o template atual, sem
 * recriar o projeto.
 *
 * A regra é uma só: rail o Supremo reescreve, scaffold só nasce se faltar.
 * Ver MANAGED_PATHS em project-files. O plano é calculado por computePlan —
 * puro, testável — a partir do que o repositório tem hoje; planTemplateSync só
 * junta isso com a leitura do GitHub. Aplicar é um PR pelos gates, nunca um
 * push direto na base.
 */

export interface SyncItem {
  path: string
  action: 'create' | 'update'
  content: string
}

export interface SyncPlan {
  /** Arquivos que faltam no repo — rail ou scaffold — e serão criados. */
  creates: SyncItem[]
  /** Rails que existem mas divergiram do template atual — serão atualizados. */
  updates: SyncItem[]
  /** Rails que já batem com o template. */
  unchanged: number
  /** Scaffold que já existe e fica intocado — funcionalidade do app mora aqui. */
  skipped: string[]
}

/**
 * Decide, arquivo a arquivo, o que a atualização faz. Puro: recebe o template
 * alvo, o que o repo tem hoje (caminhos) e o conteúdo atual dos rails que
 * existem. Sem isso na cabeça, nenhum teste conseguiria provar que scaffold
 * nunca é sobrescrito — que é a garantia inteira.
 */
export function computePlan(
  templateFiles: FileEntry[],
  existingPaths: ReadonlySet<string>,
  currentManagedContent: ReadonlyMap<string, string>,
): SyncPlan {
  const creates: SyncItem[] = []
  const updates: SyncItem[] = []
  const skipped: string[] = []
  let unchanged = 0

  for (const file of templateFiles) {
    const exists = existingPaths.has(file.path)
    const managed = isManagedPath(file.path)

    if (!exists) {
      // Falta no repo. Criar é seguro: não há nada do agente para apagar.
      creates.push({ path: file.path, action: 'create', content: file.content })
      continue
    }

    if (!managed) {
      // Existe e é scaffold: intocado. É aqui que a funcionalidade vive.
      skipped.push(file.path)
      continue
    }

    // Existe e é rail: atualiza se o conteúdo divergiu do template atual.
    const current = currentManagedContent.get(file.path)
    if (current !== undefined && current === file.content) {
      unchanged++
    } else {
      updates.push({ path: file.path, action: 'update', content: file.content })
    }
  }

  return { creates, updates, unchanged, skipped }
}

/** Nada a fazer: repo já está no template atual. */
export function planIsEmpty(plan: SyncPlan): boolean {
  return plan.creates.length === 0 && plan.updates.length === 0
}

/** Vira os itens do plano em escritas para commitFiles. */
export function planToFileChanges(plan: SyncPlan): FileChange[] {
  return [...plan.creates, ...plan.updates].map((item) => ({
    path: item.path,
    content: item.content,
  }))
}

/**
 * Monta o plano lendo o repositório: a árvore de arquivos uma vez, e o conteúdo
 * só dos rails que existem (para comparar). Scaffold não precisa de leitura de
 * conteúdo — existir já basta para deixá-lo em paz.
 */
export async function planTemplateSync(
  creds: GithubCredentials,
  options: TemplateOptions,
): Promise<SyncPlan> {
  const templateFiles = buildProjectFiles(options)
  const ref = creds.defaultBranch

  const tree = await listTree(creds, ref)
  const existingPaths = new Set(tree.map((entry) => entry.path))

  const managedExisting = templateFiles.filter(
    (file) => existingPaths.has(file.path) && isManagedPath(file.path),
  )

  const currentManagedContent = new Map<string, string>()
  await Promise.all(
    managedExisting.map(async (file) => {
      currentManagedContent.set(file.path, await readFile(creds, file.path, ref))
    }),
  )

  return computePlan(templateFiles, existingPaths, currentManagedContent)
}
