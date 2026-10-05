import path from 'node:path'
import fs from 'node:fs'
import { Command } from 'commander'
import { z } from 'zod'
import { deleteOptionsSchema, deleteTargetsSchema } from '../../../src/lib/database-delete/contract'
import { runDatabase } from './database'
import { readStableFile } from './stable-file'
import { isOperationReceipt } from './operation-receipt'

const fileSchema = z.string().min(1).max(4096)
const planFileSchema = z.object({ data: z.object({ planToken: deleteOptionsSchema.options[1].shape.planToken }) })

function readJson(cwd: string, file: string, maximumBytes: number): unknown {
  let content: string
  try { content = readStableFile(path.resolve(cwd, fileSchema.parse(file)), maximumBytes, cwd).content }
  catch (error) { throw new Error(`Arquivo de exclusão inválido: ${error instanceof Error ? error.message : 'arquivo não reconhecido'}`) }
  try { return JSON.parse(content) as unknown }
  catch { throw new Error('Arquivo de exclusão inválido: conteúdo não é JSON válido.') }
}

function savePlan(cwd: string, file: string, plan: unknown): void {
  const full = path.resolve(cwd, fileSchema.parse(file)), relative = path.relative(cwd, full)
  if (!relative.startsWith(`.supremo${path.sep}`) || !relative.endsWith('.json')) throw new Error('Salve o plano em arquivo JSON dentro do projeto, sob .supremo/.')
  let directory = path.dirname(full)
  for (;;) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('O diretório do plano contém link simbólico ou tipo inválido.')
    if (directory === cwd) break
    directory = path.dirname(directory)
  }
  // Plans are advisory files, never overwrite source files or a previous plan.
  fs.writeFileSync(full, JSON.stringify(plan) + '\n', { flag: 'wx', mode: 0o600 })
}

/** The agent supplies only exact primary keys or a server-issued plan. SQL,
 * provider credentials and connection selectors never enter this channel. */
export function registerDataDeleteCommands(program: Command): void {
  const data = program.command('data').description('Planeja e executa exclusões pontuais autorizadas no desenvolvimento')
  data.command('delete-plan').description('Inspeciona até 25 registros por chave primária, sem apagar dados; retorna plano com prazo')
    .requiredOption('--file <path>', 'JSON local com array de { table, key }; filhos antes dos pais')
    .requiredOption('--environment <environment>', 'Somente development explicitamente selecionado')
    .option('--output <path>', 'Salva a resposta em arquivo JSON novo sob .supremo/, sem sobrescrever')
    .action(async (options: { file: string; environment: string; output?: string }) => {
      const cwd = process.cwd()
      const { operation, ...fields } = deleteOptionsSchema.parse({ operation: 'data-delete-plan', environment: options.environment,
        targets: deleteTargetsSchema.parse(readJson(cwd, options.file, 256 * 1024)) })
      const result = await runDatabase(operation, cwd, fields)
      if (options.output !== undefined && !isOperationReceipt(result)) savePlan(cwd, options.output, result)
      console.log(JSON.stringify(result))
    })
  data.command('delete-apply').description('Aplica uma única vez o plano revisado e autorizado; não aguarda testes ou CI')
    .requiredOption('--plan-file <path>', 'JSON completo devolvido por data delete-plan')
    .requiredOption('--authorization <text>', 'Pedido explícito do usuário que autoriza exatamente os registros do plano')
    .requiredOption('--environment <environment>', 'Somente development explicitamente selecionado')
    .action(async (options: { planFile: string; environment: string; authorization: string }) => {
      const cwd = process.cwd()
      const plan = planFileSchema.parse(readJson(cwd, options.planFile, 1_000_000))
      const { operation, ...fields } = deleteOptionsSchema.parse({ operation: 'data-delete-apply', environment: options.environment,
        planToken: plan.data.planToken, authorization: options.authorization })
      console.log(JSON.stringify(await runDatabase(operation, cwd, fields)))
    })
}
