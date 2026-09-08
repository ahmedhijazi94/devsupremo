import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { EnginePolicy } from './engine-policy'
import { runWorkerProcess, type WorkerProcessOptions } from './worker-process'
import { readStableFile } from './stable-file'
import { isRunnerLaunchUnavailable, RepairRunnerUnavailableError, resolveRepairExecutable } from './repair-executable'

export const repairProposalSchema = z.object({
  summary: z.string().min(1).max(500),
  files: z.array(z.object({ path: z.string().min(1).max(240), content: z.string().max(512 * 1024) }).strict()).min(1).max(20),
}).strict()
export type RepairProposal = z.infer<typeof repairProposalSchema>
const outputSchema = { type: 'object', additionalProperties: false, required: ['summary', 'files'], properties: {
  summary: { type: 'string' }, files: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } } },
} }
export type RepairRunner = 'codex' | 'claude'
export type ProcessRunner = (executable: string, args: readonly string[], options: WorkerProcessOptions) => Promise<{ stdout: string; stderr: string }>

/** CLI permissions are tightened, never bypassed. The provider only proposes JSON;
 * Supremo, not the model, owns every candidate and live-workspace write. */
export async function runRepairProposal(runner: RepairRunner, inferenceDir: string, prompt: string,
  policy: EnginePolicy['auto_heal'], signal?: AbortSignal, processRunner: ProcessRunner = runWorkerProcess,
  resolveExecutable: (runner: RepairRunner) => string = resolveRepairExecutable): Promise<RepairProposal> {
  if (Buffer.byteLength(prompt) > policy.max_input_bytes) throw new Error('Contexto de autocura excede o orçamento de entrada.')
  const executable = resolveExecutable(runner)
  const execute = async (args: readonly string[], options: WorkerProcessOptions): ReturnType<ProcessRunner> => {
    try { return await processRunner(executable, args, options) }
    catch (error) {
      if (isRunnerLaunchUnavailable(error)) throw new RepairRunnerUnavailableError(runner)
      throw error
    }
  }
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
    SUPREMO_REPAIR: '1' }
  const options: WorkerProcessOptions = { cwd: inferenceDir, env, input: prompt, timeoutMs: policy.timeout_ms,
    maxOutputBytes: policy.max_output_bytes, signal }
  const deadline = Date.now() + policy.timeout_ms
  let raw: unknown
  if (runner === 'codex') {
    // Enumerate effective server names without emitting their configuration. An
    // unsupported CLI fails closed instead of inheriting writable external tools.
    const inventory = await execute(['mcp', 'list', '--json'], { ...options, input: undefined, timeoutMs: Math.min(policy.timeout_ms, 10_000) })
    const serverSchema = z.array(z.object({ name: z.string().max(200), enabled: z.boolean(), transport: z.object({ type: z.enum(['stdio', 'streamable_http']) }) }))
    const servers = serverSchema.parse(JSON.parse(inventory.stdout))
    const schema = path.join(inferenceDir, 'output-schema.json')
    const output = path.join(inferenceDir, 'proposal.json')
    fs.writeFileSync(schema, JSON.stringify(outputSchema), { mode: 0o600 })
    const restrictions = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'computer_use', 'multi_agent']
      .flatMap(feature => ['-c', `features.${feature}=false`])
    if (servers.some(server => !/^[a-zA-Z0-9_-]+$/.test(server.name))) throw new Error('Nome de servidor MCP não representável com segurança nesta CLI.')
    // Some app-provided servers exist only in the effective inventory. Disabling
    // them must retain a valid, neutral transport instead of creating a partial table.
    const mcp = servers.flatMap(server => ['-c', `mcp_servers.${server.name}.enabled=false`,
      ...(server.transport.type === 'stdio' ? ['-c', `mcp_servers.${server.name}.command=${JSON.stringify(process.execPath)}`,
        '-c', `mcp_servers.${server.name}.args=["-e","process.exit(0)"]`]
        : ['-c', `mcp_servers.${server.name}.url="http://127.0.0.1:9"`])])
    const inspected = await execute([...restrictions, ...mcp, 'mcp', 'list', '--json'], {
      ...options, input: undefined, timeoutMs: Math.max(1, Math.min(deadline - Date.now(), 10_000)),
    })
    if (serverSchema.parse(JSON.parse(inspected.stdout)).some(server => server.enabled)) throw new Error('Não foi possível desativar todos os MCPs para a proposta isolada.')
    await execute(['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral',
      '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', ...restrictions, ...mcp,
      '--output-schema', schema, '--output-last-message', output, ...(policy.model ? ['--model', policy.model] : []), '-'], { ...options, timeoutMs: Math.max(1, deadline - Date.now()) })
    raw = JSON.parse(readStableFile(output, policy.max_output_bytes, inferenceDir).content) as unknown
  } else {
    const result = await execute(['--print', '--restricted', '--tools', '', '--disallowedTools', 'mcp__*',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence',
      '--output-format', 'json', '--json-schema', JSON.stringify(outputSchema), '--max-budget-usd', String(policy.max_budget_usd),
      ...(policy.model ? ['--model', policy.model] : [])], options)
    const envelope = z.object({ structured_output: z.unknown(), is_error: z.boolean().optional() }).parse(JSON.parse(result.stdout))
    if (envelope.is_error) throw new Error('Runner não concluiu a proposta de autocura.')
    raw = envelope.structured_output
  }
  const proposal = repairProposalSchema.parse(raw)
  if (proposal.files.length > policy.max_changed_files || Buffer.byteLength(JSON.stringify(proposal)) > policy.max_output_bytes) {
    throw new Error('Proposta excede o orçamento autorizado de arquivos/saída.')
  }
  return proposal
}
