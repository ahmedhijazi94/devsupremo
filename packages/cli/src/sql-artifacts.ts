import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { sqlArtifactSchema, artifactPathSchema, type SqlArtifact } from '../../../src/lib/sql-artifacts/contract'
import { artifactDigest } from '../../../src/lib/sql-artifacts/service'
import { readStableFile } from './stable-file'
import { ensureRuntimeDirectory } from './runtime-files'
import { deviceIssuer } from './device-identity'
import { validateLocalTarget } from './database'
import { captureTurnCheckpoint, readJson, withTurnLock, writeJson, TurnLockBusyError } from './turn-workspace'
import type { DaemonConfig } from './daemon'

export interface SqlArtifactClient {
  request(operation: 'poll' | 'materialized' | 'advance' | 'completed' | 'conflict', fields: Record<string, unknown>): Promise<SqlArtifact | null>
}
function editing(cwd: string): boolean {
  const state = z.object({ turn: z.object({ status: z.string() }) }).safeParse(readJson(path.join(cwd, '.supremo/turns/state.json')))
  return (state.success && state.data.turn.status === 'active') || readJson(path.join(cwd, '.supremo/turns/mutation-lease.json')) !== null
}
/** Append immutable versioned files only. Existing matching content is a replay;
 * personalized or symlinked files never become evidence of materialization. */
export function materializeSqlFile(cwd: string, relative: string, content: string, expectedDigest: string): void {
  const migration = artifactPathSchema.safeParse(relative).success
  if (!migration && !/^supabase\/types\/\d{14}_[a-f0-9]{32}\.types\.ts$/.test(relative)) throw new Error('Caminho de artefato inválido.')
  if (artifactDigest(content) !== expectedDigest) throw new Error('Hash do artefato diverge.')
  const segments = relative.split('/')
  for (let index = 0; index < segments.length; index++) {
    const directory = path.join(cwd, ...segments.slice(0, index)), entry = fs.lstatSync(directory, { throwIfNoEntry: false })
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error('Diretório do artefato não regular.')
    if (!entry) fs.mkdirSync(directory, { mode: 0o755 })
  }
  const file = path.join(cwd, relative)
  if (fs.lstatSync(file, { throwIfNoEntry: false })) {
    if (artifactDigest(readStableFile(file, 2_100_000, cwd).content) !== expectedDigest) throw new Error('Arquivo local divergente; preservado.')
    return
  }
  if (migration) {
    const version = path.basename(relative).split('_')[0]!
    if (fs.readdirSync(path.dirname(file)).some(name => /^\d{14}_.*\.sql$/.test(name) && name.slice(0, 14) >= version)) throw new Error('Versão da migration colide com o histórico local ou está fora de ordem.')
  }
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o644 })
  try { fs.linkSync(temporary, file) }
  finally { fs.rmSync(temporary, { force: true }) }
}
export async function sqlArtifactTick(cwd: string, sessionId: string, client: SqlArtifactClient): Promise<void> {
  const incoming = await client.request('poll', { sessionId, ready: !editing(cwd) })
  if (!incoming) return
  await withTurnLock(cwd, async () => {
    if (editing(cwd)) return
    let artifact = sqlArtifactSchema.parse(incoming)
    const fields = { id: artifact.id, claimToken: z.string().uuid().parse(artifact.claimToken) }
    const save = (): void => { ensureRuntimeDirectory(cwd, '.supremo/sql-artifacts'); writeJson(path.join(cwd, '.supremo/sql-artifacts', `${artifact.id}.json`), { id: artifact.id, path: artifact.path, digest: artifact.digest, state: artifact.state, message: artifact.message, updatedAt: artifact.updatedAt }) }
    save()
    try { materializeSqlFile(cwd, artifact.path, artifact.content, artifact.digest) }
    catch {
      const conflict = await client.request('conflict', fields)
      if (conflict) { artifact = conflict; save() }
      return
    }
    if (artifact.state === 'materializing') {
      artifact = sqlArtifactSchema.parse(await client.request('materialized', { ...fields, digest: artifact.digest })); save()
    }
    if (['materialized', 'applying', 'applied', 'uncertain'].includes(artifact.state)) {
      artifact = sqlArtifactSchema.parse(await client.request('advance', fields)); save()
    }
    if (artifact.state === 'applied' && artifact.types) {
      try { materializeSqlFile(cwd, artifact.types.path, artifact.types.content, artifact.types.digest) }
      catch {
        const conflict = await client.request('conflict', fields)
        if (conflict) { artifact = conflict; save() }
        return
      }
      captureTurnCheckpoint(cwd, { projectId: artifact.projectId, turnId: artifact.id, environment: 'development', summary: 'Migration do painel e tipos do banco' })
      artifact = sqlArtifactSchema.parse(await client.request('completed', { ...fields, typesDigest: artifact.types.digest })); save()
    }
  })
}
export function startSqlArtifactWorker(config: DaemonConfig): () => void {
  const sessionId = crypto.randomUUID(), controller = new AbortController()
  let running = false, unavailable = false
  const client: SqlArtifactClient = { request: async (operation, fields) => {
    const secret = config.getSecret()
    if (!secret) throw new Error('Identidade do executor indisponível.')
    const expectedRef = readStableFile(path.join(config.cwd, 'supabase/.temp/project-ref'), 128, config.cwd).content.trim()
    validateLocalTarget(config.cwd, { environment: 'development', automaticMigrations: true, projectRef: expectedRef })
    const abort = new AbortController(), stop = (): void => abort.abort(), deadline = setTimeout(stop, 70_000)
    controller.signal.addEventListener('abort', stop, { once: true })
    try {
      const response = await fetch(`${deviceIssuer(config.apiBaseUrl)}/api/sql-artifacts`, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: config.projectId, expectedRef, deviceSecret: secret, operation, ...fields }), signal: abort.signal })
      if (!response.ok) throw new Error('Operação versionada indisponível; recibo preservado.')
      if (Number(response.headers.get('content-length')) > 2_500_000) throw new Error('Resposta de artefatos excede limite.')
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Resposta de artefatos ausente.')
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        while (true) {
          const result = await reader.read()
          if (result.done) break
          length += result.value.byteLength
          if (length > 2_500_000) throw new Error('Resposta de artefatos excede limite.')
          chunks.push(result.value)
        }
      } finally { await reader.cancel() }
      const text = Buffer.concat(chunks).toString('utf8')
      return z.object({ projectId: z.literal(config.projectId), artifact: sqlArtifactSchema.nullable() }).strict().parse(JSON.parse(text)).artifact
    } finally { clearTimeout(deadline); controller.signal.removeEventListener('abort', stop) }
  } }
  const tick = async (): Promise<void> => {
    if (running || controller.signal.aborted) return
    running = true
    try { await sqlArtifactTick(config.cwd, sessionId, client); unavailable = false }
    catch (error) {
      if (!(error instanceof TurnLockBusyError) && !unavailable && !controller.signal.aborted) {
        process.stderr.write('[migrations] Continuação indisponível; arquivos e recibos preservados. Nova consulta em background.\n'); unavailable = true
      }
    } finally { running = false }
  }
  void tick()
  const timer = setInterval(() => { void tick() }, 15_000)
  return () => { clearInterval(timer); controller.abort() }
}
