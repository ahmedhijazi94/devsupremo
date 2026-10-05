import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { z } from 'zod'
import { readProjectConfig } from './daemon'
import { deviceIssuer, readDeviceSecret } from './device-identity'
import { resolveKeychain } from './keychain'
import { readStableFile } from './stable-file'
import { planToolUpdate, type ToolUpdatePlan } from './runtime-update'
import { measureRuntime } from './runtime-metrics'
import { ensureRuntimeDirectory } from './runtime-files'
import { gitText, writeJson } from './turn-workspace'
import { runtimeCandidateSchema, type RuntimeCandidate } from './runtime-update-contract'
import { officialRuntimeCandidate } from './runtime-update-authority'
import { blobHash } from './validation-integrity'
import { verifyTrustedFiles } from './trusted-validation'
import { inspectRuntimeVersions } from './runtime-version'

const MAX_BYTES = 32 * 1024 * 1024
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/)
const releaseSchema = z.object({ version: versionSchema, digest: z.string().regex(/^[a-f0-9]{64}$/),
  url: z.string(), queueProtocol: z.literal(2), protocol: z.literal(2), minimumCli: versionSchema }).strict()
const manifestSchema = z.object({ name: z.literal('supremo-cli'), version: versionSchema,
  bin: z.object({ supremo: z.literal('dist/bin.js') }).strict(), engines: z.object({ node: z.literal('>=18') }).strict() }).strict()
const sha = (value: Buffer): string => crypto.createHash('sha256').update(value).digest('hex')

/** Parse the two regular files emitted by packCli; never extract arbitrary tar paths. */
export function unpackOfficialCli(bytes: Buffer): { manifest: string; bundle: string; version: string } {
  const tar = gunzipSync(bytes, { maxOutputLength: MAX_BYTES })
  const entries = new Map<string, string>()
  let offset = 0
  while (offset + 512 <= tar.length && tar[offset] !== 0) {
    const header = tar.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, '')
    const sizeString = header.subarray(124, 136).toString().replace(/\0.*$/, '').trim()
    const size = /^[0-7]+$/.test(sizeString) ? parseInt(sizeString, 8) : -1
    const checksum = parseInt(header.subarray(148, 156).toString().trim(), 8)
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
    if (!['package/package.json', 'package/dist/bin.js'].includes(name) || entries.has(name) || header[156] !== 48 ||
      header.subarray(157, 257).some(byte => byte !== 0) || header.subarray(345, 500).some(byte => byte !== 0) ||
      size < 0 || offset + 512 + size > tar.length || checksum !== actual) throw new Error('Pacote oficial possui estrutura inválida.')
    entries.set(name, new TextDecoder('utf-8', { fatal: true }).decode(tar.subarray(offset + 512, offset + 512 + size)))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  if (entries.size !== 2 || tar.length - offset < 1024 || tar.subarray(offset).some(byte => byte !== 0)) throw new Error('Pacote oficial incompleto.')
  const manifest = entries.get('package/package.json')!, bundle = entries.get('package/dist/bin.js')!
  return { manifest, bundle, version: manifestSchema.parse(JSON.parse(manifest)).version }
}

async function boundedFetch(url: string, limit: number, fetcher: typeof fetch): Promise<Buffer> {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(10_000), cache: 'no-store' })
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) throw new Error('Versão oficial indisponível; ferramentas atuais preservadas.')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const value = await reader.read()
      if (value.done) break
      length += value.value.length
      if (length > limit) throw new Error('Pacote oficial excede o tamanho permitido.')
      chunks.push(value.value)
    }
  } finally { await reader.cancel() }
  return Buffer.concat(chunks)
}
function lowerVersion(candidate: string, current: string): boolean {
  const left = candidate.split('.').map(Number), right = current.split('.').map(Number)
  for (let i = 0; i < 3; i++) { if (left[i] !== right[i]) return left[i]! < right[i]! }
  return false
}
export interface ReleaseDeps { fetcher: typeof fetch; authorized: (projectId: string, issuer: string) => boolean; candidate: (projectId: string, issuer: string) => Promise<RuntimeCandidate | null> }
const defaults: ReleaseDeps = { fetcher: fetch,
  authorized: (projectId, issuer) => readDeviceSecret(resolveKeychain(), projectId, issuer) !== null, candidate: officialRuntimeCandidate }

/** Prepare immutable Git objects with a private index. HEAD, user staging,
 * dependencies and preview are untouched; normal transactional activation follows. */
export async function planOfficialUpdate(cwd: string, deps: ReleaseDeps = defaults): Promise<ToolUpdatePlan | null> {
  return measureRuntime(cwd, 'update', async () => {
    const project = readProjectConfig(cwd)
    if (!project) throw new Error('Projeto ainda não autorizado para atualização.')
    const issuer = deviceIssuer(project.apiBaseUrl)
    if (!deps.authorized(project.projectId, issuer)) throw new Error('Origem não corresponde a uma identidade autorizada; nenhuma atualização baixada.')
    const release = releaseSchema.parse(JSON.parse((await boundedFetch(`${issuer}/api/cli/release`, 32 * 1024, deps.fetcher)).toString()))
    if (release.url !== `/api/cli/${release.digest}.tgz`) throw new Error('Endereço do pacote diverge do manifesto oficial.')
    const bytes = await boundedFetch(`${issuer}${release.url}`, MAX_BYTES, deps.fetcher)
    if (sha(bytes) !== release.digest) throw new Error('Checksum do pacote oficial diverge; ferramentas preservadas.')
    const candidate = unpackOfficialCli(bytes)
    if (candidate.version !== release.version || lowerVersion(candidate.version, release.minimumCli)) throw new Error('Versão do executável diverge do protocolo anunciado.')
    const currentManifest = readStableFile(path.join(cwd, 'tools/supremo-cli/package.json'), 64 * 1024, cwd).content
    const currentVersion = z.object({ version: versionSchema }).parse(JSON.parse(currentManifest)).version
    if (lowerVersion(candidate.version, currentVersion)) throw new Error('Downgrade automático não permitido.')
    const currentBundle = readStableFile(path.join(cwd, 'tools/supremo-cli/dist/bin.js'), MAX_BYTES, cwd).content
    const source = await deps.candidate(project.projectId, issuer)
    const template = source ? runtimeCandidateSchema.parse(source) : null
    if (template && (template.projectId !== project.projectId || template.cliDigest !== release.digest)) throw new Error('Candidato e pacote oficial divergiram; prepare novamente.')
    if (template) verifyTrustedFiles(cwd)
    const additions = (template?.files ?? []).filter(file => {
      const target = path.join(cwd, file.path)
      const current = fs.lstatSync(target, { throwIfNoEntry: false }) ? readStableFile(target, MAX_BYTES, cwd).content : null
      if (current === file.content) return false
      if ((current === null ? null : blobHash(current)) !== file.beforeBlob) throw new Error(`Personalização ou base divergente em ${file.path}; arquivo preservado.`)
      return true
    })
    if (currentBundle === candidate.bundle && currentVersion === candidate.version && !additions.length &&
      (!template || inspectRuntimeVersions(cwd).compatible)) return null
    const base = gitText(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])
    const stageId = crypto.randomUUID(), directory = ensureRuntimeDirectory(cwd, '.supremo/runtime-update')
    writeJson(path.join(directory, `${stageId}-source.json`), { issuer, ...release, fetchedAt: Date.now() })
    const index = path.join(directory, `${stageId}.index`)
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'Supremo', GIT_AUTHOR_EMAIL: 'runtime@supremo.local',
      GIT_COMMITTER_NAME: 'Supremo', GIT_COMMITTER_EMAIL: 'runtime@supremo.local' }
    const git = (args: string[], input?: string): string => execFileSync('git', args, { cwd, env, input, encoding: 'utf8', maxBuffer: MAX_BYTES, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    try {
      git(['read-tree', base])
      for (const [relative, content, mode] of [
        ['tools/supremo-cli/package.json', candidate.manifest, '100644'],
        ['tools/supremo-cli/dist/bin.js', candidate.bundle, '100755'],
        ...additions.map(file => [file.path, file.content, file.path.startsWith('.githooks/') || file.path.endsWith('.mjs') ? '100755' : '100644']),
      ]) {
        const blob = git(['hash-object', '-w', '--stdin'], content)
        git(['update-index', '--add', '--cacheinfo', `${mode},${blob},${relative}`])
      }
      const tree = git(['write-tree']), target = git(['commit-tree', tree, '-p', base], `Supremo official runtime ${candidate.version}\n`)
      git(['update-ref', `refs/supremo/runtime-candidates/${stageId}`, target])
      const plan = planToolUpdate(cwd, base, target, template ? { authority: { projectId: project.projectId, issuer, revision: template.revision }, templateVersion: template.templateVersion } : undefined)
      writeJson(path.join(directory, `${plan.id}-source.json`), { issuer, ...release, candidateRef: target, fetchedAt: Date.now() })
      return plan
    } finally { fs.rmSync(index, { force: true }); fs.rmSync(`${index}.lock`, { force: true }) }
  })
}
