import type { Command } from 'commander'
import { operationStatus, resumeDatabaseOperation } from './durable-operations'
import { inspectRuntimeVersions } from './runtime-version'
import { applyToolUpdate, planToolUpdate, readToolUpdate } from './runtime-update'
import { controlRuntimeService, runSupervisedDaemon, serviceStatus } from './runtime-service'
import { planOfficialUpdate } from './runtime-release'
import { verifyTrustedFiles } from './trusted-validation'

export function registerRuntimeCommands(program: Command): void {
  const operation = program.command('operation').description('Consulta recibos duráveis sem repetir efeitos')
  operation.command('status <id>')
    .action((id: string) => { console.log(JSON.stringify(operationStatus(process.cwd(), id))) })
  operation.command('resume <id>').description('Retoma somente uma recusa anterior ao envio, após aprovação do dono')
    .action((id: string) => { console.log(JSON.stringify(resumeDatabaseOperation(process.cwd(), id))) })
  const runtime = program.command('runtime').description('Versão efetivamente ativa, atualização transacional e retomada local')
  runtime.command('status').action(() => { console.log(JSON.stringify({ ...inspectRuntimeVersions(process.cwd()), service: serviceStatus(process.cwd()) })) })
  runtime.command('check-tools').description('Verifica o candidato com a política incluída nesta versão, sem executar testes ou alterar o projeto')
    .action(() => { verifyTrustedFiles(process.cwd()); console.log(JSON.stringify({ status: 'verified' })) })
  runtime.command('update').description('Obtém o candidato oficial na origem já autorizada e ativa com rollback')
    .option('--prepare-only', 'Prepara um plano sem substituir as ferramentas')
    .option('--with-dependencies', 'Instala dependências em candidato isolado; exige preview comprovadamente parado')
    .action(async (options: { prepareOnly?: boolean; withDependencies?: boolean }) => {
      const plan = await planOfficialUpdate(process.cwd())
      if (!plan) { console.log(JSON.stringify({ status: 'up_to_date', runtime: inspectRuntimeVersions(process.cwd()) })); return }
      const result = options.prepareOnly ? plan : await applyToolUpdate(process.cwd(), plan.id, undefined, options)
      console.log(JSON.stringify({ id: result.id, status: result.status, error: result.error, paths: result.files.map(file => file.path) }))
      if (!options.prepareOnly && result.status !== 'active') process.exitCode = 1
    })
  runtime.command('plan-update').requiredOption('--base <ref>', 'Base conhecida das ferramentas').requiredOption('--target <ref>', 'Revisão local revisada para atualização')
    .action((options: { base: string; target: string }) => {
      const plan = planToolUpdate(process.cwd(), options.base, options.target)
      console.log(JSON.stringify({ id: plan.id, status: plan.status, base: plan.base, target: plan.target, paths: plan.files.map(file => file.path) }))
    })
  runtime.command('apply-update <id>').option('--with-dependencies', 'Instala dependências em candidato isolado; exige preview comprovadamente parado').action(async (id: string, options: { withDependencies?: boolean }) => {
    const result = await applyToolUpdate(process.cwd(), id, undefined, options)
    console.log(JSON.stringify({ id: result.id, status: result.status, error: result.error }))
    if (result.status !== 'active') process.exitCode = 1
  })
  runtime.command('update-status <id>').action((id: string) => {
    const plan = readToolUpdate(process.cwd(), id)
    console.log(JSON.stringify({ id: plan.id, status: plan.status, error: plan.error, paths: plan.files.map(file => file.path) }))
  })
  runtime.command('service <action>').description('install, status, pause, resume ou remove; serviço do usuário sem privilégios administrativos')
    .action(async (action: string) => { console.log(JSON.stringify(await controlRuntimeService(process.cwd(), action))) })
  runtime.command('supervise').description('Entrada interna do serviço supervisionado').action(async () => { await runSupervisedDaemon(process.cwd()) })
}
