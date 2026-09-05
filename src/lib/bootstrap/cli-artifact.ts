import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

/** Arquivo npm autocontido: só manifesto e bundle, sem configurações/credenciais. */
export function packCli(version: string, bundle: string): Buffer {
  const manifest = JSON.stringify({ name: 'supremo-cli', version, bin: { supremo: 'dist/bin.js' }, engines: { node: '>=18' } })
  const blocks: Buffer[] = []
  for (const [name, content] of [['package/package.json', manifest], ['package/dist/bin.js', bundle]]) {
    const bytes = Buffer.from(content!)
    const header = Buffer.alloc(512)
    header.write(name!, 0, 100)
    const octal = (value: number, offset: number, length: number) => header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length)
    octal(name!.endsWith('.js') ? 0o755 : 0o644, 100, 8)
    octal(0, 108, 8); octal(0, 116, 8)
    octal(bytes.length, 124, 12); octal(0, 136, 12)
    header.fill(32, 148, 156)
    header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263)
    const sum = header.reduce((acc, value) => acc + value, 0)
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}
let cached: { bytes: Buffer; digest: string } | undefined
export function cliArtifact(): { bytes: Buffer; digest: string } {
  if (cached) return cached
  const root = path.join(process.cwd(), 'packages/cli')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }
  const bytes = packCli(pkg.version, fs.readFileSync(path.join(root, 'dist/bin.js'), 'utf8'))
  cached = { bytes, digest: createHash('sha256').update(bytes).digest('hex') }
  return cached
}
