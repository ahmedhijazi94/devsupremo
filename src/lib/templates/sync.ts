import { createHash } from 'node:crypto'
import type { GithubCredentials } from '@/lib/projects/repository'
import type { FileChange } from '@/lib/github/client'
import { listTree, readFile } from '@/lib/github/client'
import { withDevelopmentPolicy } from './development-policy'
import { upgradeValidationPackages } from './sync-validation'
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
 * alvo, o que o repo tem hoje (caminhos) e o conjunto de rails que já batem com
 * o template. Sem isso na cabeça, nenhum teste conseguiria provar que scaffold
 * nunca é sobrescrito — que é a garantia inteira.
 */
export function computePlan(
  templateFiles: FileEntry[],
  existingPaths: ReadonlySet<string>,
  managedUpToDate: ReadonlySet<string>,
  existingInstructions: ReadonlyMap<string, string> = new Map(),
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

    if ((file.path === 'AGENTS.md' || file.path === 'CLAUDE.md') && existingInstructions.has(file.path)) {
      const current = existingInstructions.get(file.path)!
      const content = withDevelopmentPolicy(current)
      if (content === current) unchanged++
      else updates.push({ path: file.path, action: 'update', content })
      continue
    }

    if (!managed) {
      // Existe e é scaffold: intocado. É aqui que a funcionalidade vive.
      skipped.push(file.path)
      continue
    }

    // Existe e é rail: atualiza se divergiu do template atual.
    if (managedUpToDate.has(file.path)) {
      unchanged++
    } else {
      updates.push({ path: file.path, action: 'update', content: file.content })
    }
  }

  return { creates, updates, unchanged, skipped }
}

/** O sha git de um conteúdo — igual ao que o GitHub guarda para o blob. */
export function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, 'utf8')
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex')
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
 * Monta o plano com UMA chamada: a árvore do repositório traz o sha de cada
 * arquivo, e o sha é o hash git do conteúdo. Um rail está em dia quando o sha
 * do template bate com o sha da árvore — sem baixar arquivo nenhum. Isso deixa
 * a conferência barata o bastante para o cartão rodar sozinho ao abrir.
 */
export async function planTemplateSync(
  creds: GithubCredentials,
  options: TemplateOptions,
): Promise<SyncPlan> {
  const templateFiles = buildProjectFiles(options)
  const ref = creds.defaultBranch

  const tree = await listTree(creds, ref)
  const existingPaths = new Set(tree.map((entry) => entry.path))
  const shaByPath = new Map(tree.map((entry) => [entry.path, entry.sha]))

  const managedUpToDate = new Set<string>()
  for (const file of templateFiles) {
    if (!existingPaths.has(file.path) || !isManagedPath(file.path)) continue
    if (shaByPath.get(file.path) === gitBlobSha(file.content)) {
      managedUpToDate.add(file.path)
    }
  }

  // Agent instructions contain user-owned additions. Read only these two files
  // when needed and update the platform block, never replace the whole document.
  const instructionPaths = ['AGENTS.md', 'CLAUDE.md', 'package.json', 'package-lock.json'].filter((file) => existingPaths.has(file))
  const instructions = await Promise.allSettled(instructionPaths.map(async (file) => {
    const content = await readFile(creds, file, ref)
    // The tree and content must describe the same revision, even if main moved.
    if (gitBlobSha(content) !== shaByPath.get(file)) throw new Error('A base mudou durante a leitura das instruções; tente atualizar novamente.')
    return [file, content] as const
  }))
  const existingInstructions = new Map<string, string>()
  for (const result of instructions) {
    if (result.status === 'rejected') throw result.reason
    existingInstructions.set(...result.value)
  }
  const plan = computePlan(templateFiles, existingPaths, managedUpToDate, existingInstructions)
  const currentPackage = existingInstructions.get('package.json')
  const currentLock = existingInstructions.get('package-lock.json')
  if (currentPackage && currentLock) {
    const targetPackage = templateFiles.find(file => file.path === 'package.json')!.content
    const targetLock = templateFiles.find(file => file.path === 'package-lock.json')!.content
    const upgrade = upgradeValidationPackages(currentPackage, currentLock, targetPackage, targetLock)
    for (const [path, content, current] of [
      ['package.json', upgrade.packageContent, currentPackage],
      ['package-lock.json', upgrade.lockContent, currentLock],
    ] as const) if (content !== current) {
      plan.updates.push({ path, action: 'update', content })
      plan.skipped = plan.skipped.filter(file => file !== path)
    }
  }
  return plan
}
