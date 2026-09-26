import { Command } from 'commander'
import { runDatabase } from './database'
import { parseFunctionOptions } from './functions-request'

export function registerFunctionCommands(program: Command): void {
  const functions = program.command('functions').description('Publica Edge Functions e configura email HTTP por API no ambiente confirmado')
  for (const operation of ['list', 'hook-status'] as const) {
    functions.command(operation)
      .description(operation === 'list' ? 'Lista metadados das funções, sem ler código ou segredos' : 'Consulta o vínculo do Send Email Hook, sem revelar sua assinatura')
      .option('--environment <environment>', 'Ambiente confirmado', 'development')
      .action(async (options: Record<string, unknown>) => {
        console.log(JSON.stringify(await runDatabase(`functions-${operation}`, process.cwd(), parseFunctionOptions(`functions-${operation}`, options))))
      })
  }
  functions.command('status <slug>').description('Confirma o estado da função publicada')
    .option('--environment <environment>', 'Ambiente confirmado', 'development')
    .action(async (slug: string, options: Record<string, unknown>) => {
      console.log(JSON.stringify(await runDatabase('functions-status', process.cwd(), parseFunctionOptions('functions-status', { ...options, slug }))))
    })
  functions.command('deploy <slug>').description('Envia somente os arquivos explicitamente selecionados; não instala dependências nem reinicia o preview')
    .requiredOption('--entrypoint <path>', 'Arquivo de entrada relativo ao projeto, sob supabase/functions/<slug>/')
    .option('--file <path>', 'Dependência local adicional; repita para cada arquivo', (value: string, previous: string[]) => [...previous, value], [])
    .option('--import-map <path>', 'Manifesto de imports Deno relativo ao projeto')
    .option('--no-verify-jwt', 'Somente para função com autenticação própria, como assinatura Standard Webhooks')
    .option('--environment <environment>', 'Ambiente confirmado', 'development')
    .action(async (slug: string, options: Record<string, unknown>) => {
      const { file, ...fields } = options
      console.log(JSON.stringify(await runDatabase('functions-deploy', process.cwd(), parseFunctionOptions('functions-deploy', { ...fields, slug, files: file }))))
    })
  functions.command('hook-configure <slug>').description('Gera a assinatura privada e conecta a função publicada ao Send Email Hook')
    .option('--secret-name <name>', 'Variável privada lida pela função (não use o prefixo reservado SUPABASE_)', 'AUTH_SEND_EMAIL_HOOK_SECRET')
    .option('--environment <environment>', 'Ambiente confirmado', 'development')
    .action(async (slug: string, options: Record<string, unknown>) => {
      console.log(JSON.stringify(await runDatabase('functions-hook-configure', process.cwd(), parseFunctionOptions('functions-hook-configure', { ...options, slug }))))
    })
}
