import path from 'node:path'
import fs from 'node:fs'
import { Command } from 'commander'
import { z } from 'zod'
import { mutationActionSchema } from '../../../src/lib/database-mutations/contract'
import { parseDatabaseOptions } from './database-request'
import { runDatabase } from './database'
import { readStableFile } from './stable-file'
import { isOperationReceipt } from './operation-receipt'

function jsonFile(file: string): unknown {
  return JSON.parse(readStableFile(path.resolve(process.cwd(), z.string().min(1).max(4096).parse(file)), 800_000, process.cwd()).content) as unknown
}
export function registerBackendCommands(program: Command): void {
  const backend = program.command('backend').description('Capacidades, autorizações, integrações e armazenamento pelo motor')
  for (const action of ['catalog', 'policy', 'integration-status'] as const) backend.command(action).action(async () => {
    console.log(JSON.stringify(await runDatabase(`backend-${action}`)))
  })
  backend.command('operation-status <id>').action(async (id: string) => {
    console.log(JSON.stringify(await runDatabase('backend-operation-status', process.cwd(), parseDatabaseOptions('backend-operation-status', { id }))))
  })
  backend.command('approval-status <operationId>').description('Consulta a autorização pontual preparada para uma operação')
    .action(async (operationId: string) => { console.log(JSON.stringify(await runDatabase('backend-approval-status', process.cwd(), parseDatabaseOptions('backend-approval-status', { operationId })))) })
  for (const action of ['storage', 'integration', 'integration-propose', 'usage'] as const) backend.command(action).requiredOption('--file <path>', 'Contrato JSON da operação; nunca inclua uma credencial').action(async (options: { file: string }) => {
    const operation = `backend-${action}` as const
    console.log(JSON.stringify(await runDatabase(operation, process.cwd(), parseDatabaseOptions(operation, { options: jsonFile(options.file) }))))
  })
  const data = program.commands.find(command => command.name() === 'data')
  if (!data) throw new Error('Registre primeiro a família data.')
  data.command('plan').description('Prepara inserção, edição, upsert ou exclusão por chaves exatas')
    .requiredOption('--file <path>', 'JSON {type,table,rows:[{key,values?}]}')
    .requiredOption('--environment <environment>', 'development')
    .option('--output <path>', 'Arquivo novo sob .supremo/ para guardar o plano')
    .action(async (options: { file: string; environment: string; output?: string }) => {
      const result = await runDatabase('data-plan', process.cwd(), parseDatabaseOptions('data-plan', { environment: options.environment, action: mutationActionSchema.parse(jsonFile(options.file)) }))
      if (options.output && !isOperationReceipt(result)) {
        const destination = path.resolve(process.cwd(), options.output)
        const parent = path.dirname(destination), local = path.join(process.cwd(), '.supremo')
        if (parent !== local || fs.lstatSync(local).isSymbolicLink() || !destination.endsWith('.json')) throw new Error('Use um arquivo JSON novo diretamente sob .supremo/.')
        fs.writeFileSync(destination, JSON.stringify(result), { flag: 'wx', mode: 0o600 })
      }
      console.log(JSON.stringify(result))
    })
  data.command('apply').description('Aplica uma vez o plano dentro da política do dono')
    .requiredOption('--plan-file <path>', 'Resposta JSON completa de data plan')
    .requiredOption('--environment <environment>', 'development')
    .action(async (options: { planFile: string; environment: string }) => {
      const plan = z.object({ data: z.object({ planToken: z.string() }) }).parse(jsonFile(options.planFile))
      console.log(JSON.stringify(await runDatabase('data-apply', process.cwd(), parseDatabaseOptions('data-apply', { environment: options.environment, planToken: plan.data.planToken }))))
    })
}
