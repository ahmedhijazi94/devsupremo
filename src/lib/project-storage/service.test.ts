import { describe, expect, it, vi } from 'vitest'
import { storageOptionsSchema } from './contract'
import { runStorage, storageCapability, type StorageProvider } from './service'

const target = { environment: 'development' as const, expectedRef: 'projectref' }, write = { ...target, operationId: '11111111-1111-4111-8111-111111111111', bucket: 'documents' }
function provider(): StorageProvider { return { buckets: vi.fn(async () => []), list: vi.fn(async () => []), configure: vi.fn(async () => {}), deleteBucket: vi.fn(async () => {}), upload: vi.fn(async () => {}), verifyUpload: vi.fn(async () => true), download: vi.fn(async () => 'https://projectref.supabase.co/storage/v1/object/sign/file'), remove: vi.fn(async () => {}), exists: vi.fn(async () => false) } }
describe('owner storage operations', () => {
  it('rejects path traversal, URLs and unsupported fields', () => {
    for (const path of ['../x', '/x', 'x\\y', 'a//b', 'x?token=secret', 'x%2fy', 'a/./b']) expect(storageOptionsSchema.safeParse({ ...target, operation: 'storage-download', bucket: 'documents', path }).success).toBe(false)
    expect(storageOptionsSchema.safeParse({ ...target, operation: 'storage-buckets', token: 'secret' }).success).toBe(false)
  })
  it('lists and signs only explicitly scoped files', async () => {
    const p = provider()
    expect(await runStorage(p, { ...target, operation: 'storage-buckets' })).toEqual({ items: [] })
    await runStorage(p, { ...target, operation: 'storage-list', bucket: 'documents', prefix: 'a', offset: 2 })
    expect(p.list).toHaveBeenCalledWith('documents', 'a', 2)
    expect(await runStorage(p, { ...target, operation: 'storage-download', bucket: 'documents', path: 'a/b.pdf' })).toHaveProperty('expiresIn', 60)
    expect(storageCapability({ ...target, operation: 'storage-buckets' })).toBe('storage.read')
  })
  it.each(['storage-create-bucket', 'storage-update-bucket'] as const)('confirms %s settings through API readback', async operation => {
    const p = provider(); vi.mocked(p.buckets).mockResolvedValue([{ id: 'documents', public: false, file_size_limit: 100, allowed_mime_types: ['image/png'] }])
    const options = { ...write, operation, public: false, maxBytes: 100, mimeTypes: ['image/png'] }
    expect(await runStorage(p, options)).toHaveProperty('verified', true)
    expect(storageCapability(options)).toBe('storage.manage')
    vi.mocked(p.buckets).mockResolvedValue([{ id: 'documents', public: true }])
    await expect(runStorage(p, options)).rejects.toThrow('confirmada')
  })
  it('never recursively erases a nonempty bucket', async () => {
    const p = provider(); vi.mocked(p.list).mockResolvedValue([{ name: 'other-user-file' }])
    await expect(runStorage(p, { ...write, operation: 'storage-delete-bucket' })).rejects.toThrow('contém arquivos')
    expect(p.deleteBucket).not.toHaveBeenCalled()
    vi.mocked(p.list).mockResolvedValue([])
    expect(await runStorage(p, { ...write, operation: 'storage-delete-bucket' })).toHaveProperty('verified', true)
    vi.mocked(p.buckets).mockResolvedValue([{ id: 'documents' }])
    await expect(runStorage(p, { ...write, operation: 'storage-delete-bucket' })).rejects.toThrow('confirmada')
  })
  it('requires new path, bounded content and provider proof for uploads', async () => {
    const p = provider(), options = { ...write, operation: 'storage-upload' as const, path: 'a.txt', contentType: 'text/plain', content: 'dGVzdA==' }
    expect(storageCapability(options)).toBe('storage.write')
    vi.mocked(p.exists).mockResolvedValue(false)
    expect(await runStorage(p, options)).toMatchObject({ verified: true, path: 'a.txt' })
    vi.mocked(p.exists).mockResolvedValue(true)
    await expect(runStorage(p, options)).rejects.toThrow('Já existe')
    vi.mocked(p.exists).mockResolvedValue(false)
    vi.mocked(p.verifyUpload).mockResolvedValue(false)
    await expect(runStorage(p, options)).rejects.toThrow('confirmado')
    await expect(runStorage(p, { ...options, content: Buffer.alloc(512001).toString('base64') })).rejects.toThrow('512 KB')
  })
  it('checks all explicit deleted paths without touching unrelated paths', async () => {
    const p = provider(), options = { ...write, operation: 'storage-remove' as const, paths: ['a', 'b'] }
    expect(storageCapability(options)).toBe('storage.delete')
    expect(await runStorage(p, options)).toMatchObject({ verified: true, removed: 2 })
    expect(p.remove).toHaveBeenCalledWith('documents', ['a', 'b'])
    vi.mocked(p.exists).mockResolvedValue(true)
    await expect(runStorage(p, options)).rejects.toThrow('confirmada')
  })
})
