import { describe, expect, it } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { packCli, cliArtifact } from './cli-artifact'
import { GET } from '@/app/api/cli/[digest]/route'

describe('artefato da CLI servido pelo Supremo', () => {
  it('inclui somente manifesto e executável; checksum tar correto e bytes determinísticos', () => {
    const packed = packCli('1.3.0', '#!/usr/bin/env node\nconsole.log("ok")\n')
    expect(packed).toEqual(packCli('1.3.0', '#!/usr/bin/env node\nconsole.log("ok")\n'))
    const tar = gunzipSync(packed)
    const names: string[] = []
    for (let offset = 0; tar[offset];) {
      const header = tar.subarray(offset, offset + 512)
      names.push(header.subarray(0, 100).toString().replace(/\0.*$/, ''))
      const expected = parseInt(header.subarray(148, 154).toString(), 8)
      const sum = header.reduce((total, value, i) => total + (i >= 148 && i < 156 ? 32 : value), 0)
      expect(sum).toBe(expected)
      const size = parseInt(header.subarray(124, 136).toString(), 8)
      offset += 512 + Math.ceil(size / 512) * 512
    }
    expect(names).toEqual(['package/package.json', 'package/dist/bin.js'])
  })
  it('recusa hash antigo e serve exatamente os bytes cujo hash foi solicitado', async () => {
    const artifact = cliArtifact()
    const request = new Request('https://supremo.test/api/cli/test.tgz')
    const missing = await GET(request, { params: Promise.resolve({ digest: 'old.tgz' }) })
    expect(missing.status).toBe(404)
    const response = await GET(request, { params: Promise.resolve({ digest: `${artifact.digest}.tgz` }) })
    expect(response.status).toBe(200)
    expect(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex')).toBe(artifact.digest)
    expect(response.headers.get('cache-control')).toContain('immutable')
  })
})
