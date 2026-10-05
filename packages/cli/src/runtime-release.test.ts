import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { packCli } from '../../../src/lib/bootstrap/cli-artifact'
import { planOfficialUpdate, unpackOfficialCli, type ReleaseDeps } from './runtime-release'
import { gitText, writeJson } from './turn-workspace'
import { blobHash } from './validation-integrity'

// Transport/CAS fixtures use a tiny project; generated policy integrity has its
// own real-template tests in trusted-validation and generated-worker suites.
vi.mock('./trusted-validation', () => ({ verifyTrustedFiles: () => {} }))

let cwd: string
const issuer = 'https://supremo.example/install'
const projectId = 'b7a0a9b0-1343-494d-a3d1-21ff14e1dfb0'
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-official-update-'))
  gitText(cwd, ['init', '-b', 'main']); gitText(cwd, ['config', 'user.name', 'Fixture']); gitText(cwd, ['config', 'user.email', 'test@example.invalid'])
  fs.mkdirSync(path.join(cwd, 'tools/supremo-cli/dist'), { recursive: true })
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.supremo/\nnode_modules/\n')
  fs.writeFileSync(path.join(cwd, 'tools/supremo-cli/package.json'), JSON.stringify({ name: 'supremo-cli', version: '1.13.0' }))
  fs.writeFileSync(path.join(cwd, 'tools/supremo-cli/dist/bin.js'), 'console.log("1.13.0")\n')
  fs.writeFileSync(path.join(cwd, 'app.txt'), 'app base\n')
  gitText(cwd, ['add', '.']); gitText(cwd, ['commit', '-m', 'base'])
  writeJson(path.join(cwd, '.supremo/project.json'), { projectId, supremoUrl: issuer })
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(cwd, { recursive: true, force: true }) })
function transport(version = '1.14.0') {
  const bytes = packCli(version, `console.log("${version}")\n`), digest = crypto.createHash('sha256').update(bytes).digest('hex')
  const manifest = { version, digest, url: `/api/cli/${digest}.tgz`, queueProtocol: 2, protocol: 2, minimumCli: '1.14.0' }
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith('/release') ? Response.json(manifest) : new Response(new Uint8Array(bytes)))
  const deps: ReleaseDeps = { fetcher, authorized: vi.fn(() => true), candidate: async () => null }
  return { bytes, manifest, deps, fetcher }
}
it('prepares the official candidate using a private index without moving HEAD, staging or preview', async () => {
  const { deps, fetcher, manifest } = transport()
  fs.writeFileSync(path.join(cwd, 'app.txt'), 'draft app\n'); gitText(cwd, ['add', 'app.txt'])
  writeJson(path.join(cwd, '.supremo/preview.json'), { pid: 91, port: 3011 })
  const head = gitText(cwd, ['rev-parse', 'HEAD']), index = gitText(cwd, ['write-tree'])
  const plan = await planOfficialUpdate(cwd, deps)
  expect(plan).toMatchObject({ status: 'planned', base: head })
  expect(plan?.files.map(file => file.path)).toEqual(['tools/supremo-cli/package.json', 'tools/supremo-cli/dist/bin.js'])
  expect(gitText(cwd, ['show', `${plan!.target}:tools/supremo-cli/dist/bin.js`])).toBe('console.log("1.14.0")')
  expect(fs.readFileSync(path.join(cwd, 'tools/supremo-cli/dist/bin.js'), 'utf8')).toContain('1.13.0')
  expect(gitText(cwd, ['rev-parse', 'HEAD'])).toBe(head); expect(gitText(cwd, ['write-tree'])).toBe(index)
  expect(fs.readFileSync(path.join(cwd, '.supremo/preview.json'), 'utf8')).toContain('3011')
  expect(deps.authorized).toHaveBeenCalledWith(projectId, issuer)
  expect(fetcher.mock.calls.map(call => call[0])).toEqual([`${issuer}/api/cli/release`, `${issuer}${manifest.url}`])
  expect(fetcher.mock.calls.every(call => call[1]?.redirect === 'error' && !call[1]?.headers)).toBe(true)
})
it('refuses unknown issuer before any download and never sends a credential to the release endpoint', async () => {
  const { deps, fetcher } = transport(); deps.authorized = () => false
  await expect(planOfficialUpdate(cwd, deps)).rejects.toThrow('identidade autorizada')
  expect(fetcher).not.toHaveBeenCalled()
})
it('prepares server-authorized template tools and instructions along with the pinned CLI without manual Git refs', async () => {
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'Managed project instructions\n')
  gitText(cwd, ['add', '-f', '.']); gitText(cwd, ['commit', '-m', 'trusted template'])
  writeJson(path.join(cwd, '.supremo/project.json'), { projectId, supremoUrl: issuer })
  const { deps, manifest } = transport(), before = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8')
  deps.candidate = async () => ({ projectId, revision: '11111111-1111-4111-8111-111111111111', cliDigest: manifest.digest,
    templateVersion: '4.0.18', baseSha: gitText(cwd, ['rev-parse', 'HEAD']), files: [{ path: 'AGENTS.md', beforeBlob: blobHash(before), content: before + '\nNew managed workflow\n' }] })
  const plan = await planOfficialUpdate(cwd, deps)
  expect(plan).toMatchObject({ authority: { projectId, issuer }, templateVersion: '4.0.18' })
  expect(plan?.files.map(file => file.path)).toContain('AGENTS.md')
  expect(fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8')).toBe(before)
})
it('does not report up to date when current official files still have no confirmed active daemon', async () => {
  const { deps, manifest, bytes } = transport(), artifact = unpackOfficialCli(bytes)
  fs.writeFileSync(path.join(cwd, 'tools/supremo-cli/package.json'), artifact.manifest)
  fs.writeFileSync(path.join(cwd, 'tools/supremo-cli/dist/bin.js'), artifact.bundle)
  gitText(cwd, ['add', '.']); gitText(cwd, ['commit', '-m', 'current official files'])
  deps.candidate = async () => ({ projectId, revision: '11111111-1111-4111-8111-111111111111', cliDigest: manifest.digest,
    templateVersion: '4.0.18', baseSha: gitText(cwd, ['rev-parse', 'HEAD']), files: [] })
  const plan = await planOfficialUpdate(cwd, deps)
  expect(plan).toMatchObject({ status: 'planned', files: [], authority: { projectId, issuer } })
})
it('refuses arbitrary download addresses and corrupt bytes before preparing executable objects', async () => {
  const { deps, manifest, fetcher } = transport(); manifest.url = 'https://attacker.invalid/cli.tgz'
  await expect(planOfficialUpdate(cwd, deps)).rejects.toThrow('Endereço')
  expect(fetcher).toHaveBeenCalledTimes(1)
  manifest.url = `/api/cli/${manifest.digest}.tgz`
  fetcher.mockImplementation(async url => String(url).endsWith('/release') ? Response.json(manifest) : new Response('corrupt'))
  await expect(planOfficialUpdate(cwd, deps)).rejects.toThrow('Checksum')
  expect(fs.existsSync(path.join(cwd, '.supremo/runtime-update'))).toBe(false)
})
it('preserves locally personalized tools and refuses automatic downgrade', async () => {
  fs.writeFileSync(path.join(cwd, 'tools/supremo-cli/dist/bin.js'), 'custom CLI\n')
  await expect(planOfficialUpdate(cwd, transport().deps)).rejects.toThrow('Personalização')
  expect(fs.readFileSync(path.join(cwd, 'tools/supremo-cli/dist/bin.js'), 'utf8')).toBe('custom CLI\n')
  fs.writeFileSync(path.join(cwd, 'tools/supremo-cli/package.json'), JSON.stringify({ version: '1.15.0' }))
  await expect(planOfficialUpdate(cwd, transport().deps)).rejects.toThrow('Downgrade')
})
it('accepts only the two regular archive files, with valid checksums and matching manifest', () => {
  const { bytes } = transport()
  expect(unpackOfficialCli(bytes).version).toBe('1.14.0')
  const unsafe = gunzipSync(bytes); unsafe[156] = 50
  unsafe.fill(32, 148, 156)
  const checksum = unsafe.subarray(0, 512).reduce((sum, value) => sum + value, 0)
  unsafe.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  expect(() => unpackOfficialCli(gzipSync(unsafe))).toThrow('estrutura inválida')
  const truncated = gunzipSync(bytes).subarray(0, 512)
  expect(() => unpackOfficialCli(gzipSync(truncated))).toThrow()
})
it('rejects a symlinked staging directory without writing outside the project', async () => {
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-release-outside-'))
  try {
    fs.symlinkSync(external, path.join(cwd, '.supremo/runtime-update'))
    await expect(planOfficialUpdate(cwd, transport().deps)).rejects.toThrow('não regular')
    expect(fs.readdirSync(external)).toEqual([])
  } finally { fs.rmSync(external, { recursive: true, force: true }) }
})
