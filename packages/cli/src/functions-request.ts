import path from 'node:path'
import { z } from 'zod'
import { functionOperationSchema, functionSlugSchema, functionPathSchema, functionDeploySchema, functionOptionsSchema } from '../../../src/lib/edge-functions/contract'
import { readStableFile } from './stable-file'

// Local requests carry an explicit file selection, never source, shell commands,
// provider URLs or credentials. Only the authorized daemon reads these files.
const localDeploySchema = z.object({
  slug: functionSlugSchema,
  environment: z.enum(['development', 'production']),
  entrypoint: functionPathSchema,
  files: z.array(functionPathSchema).max(64).default([]),
  importMap: functionPathSchema.optional(),
  verifyJwt: z.boolean().default(true),
}).strict()
export type LocalFunctionDeploy = z.infer<typeof localDeploySchema>
export type FunctionFields = Partial<LocalFunctionDeploy> & { secretName?: string }

export function parseFunctionOptions(operation: string, raw: unknown): FunctionFields {
  functionOperationSchema.parse(operation)
  if (operation === 'functions-deploy') return localDeploySchema.parse(raw)
  const fields = z.record(z.string(), z.unknown()).parse(raw)
  const parsed = functionOptionsSchema.parse({ ...fields, operation })
  if (parsed.operation === 'functions-deploy') throw new Error('Publicação exige seleção local de arquivos.')
  const { operation: _selected, ...options } = parsed
  void _selected
  return options
}

/** Stable bounded reads also reject symlinked parents and concurrent rewrites. */
export function readFunctionDeployment(cwd: string, raw: unknown): z.infer<typeof functionDeploySchema> {
  const options = localDeploySchema.parse(raw)
  const names = [...new Set([options.entrypoint, ...(options.importMap ? [options.importMap] : []), ...options.files])]
  if (names.length > 64) throw new Error('A função excede o limite de 64 arquivos.')
  let bytes = 0
  const files = names.map(name => {
    const file = readStableFile(path.join(cwd, name), 128 * 1024, cwd)
    bytes += Buffer.byteLength(file.content)
    if (bytes > 512 * 1024) throw new Error('A função excede o limite total de 512 KiB.')
    return { path: name, content: file.content }
  })
  return functionDeploySchema.parse({ ...options, files })
}
