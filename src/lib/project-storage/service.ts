import { OperationError, type OperationCapability } from '../backend-operations/contract'
import { storageOptionsSchema, type StorageOptions } from './contract'

export type StorageItem = Record<string, unknown>
export interface StorageProvider {
  buckets(): Promise<StorageItem[]>
  list(bucket: string, prefix: string, offset: number): Promise<StorageItem[]>
  configure(bucket: string, settings: { public: boolean; maxBytes: number; mimeTypes: string[] }, create: boolean): Promise<void>
  deleteBucket(bucket: string): Promise<void>
  upload(bucket: string, path: string, content: string, contentType: string): Promise<void>
  verifyUpload(bucket: string, path: string, content: string, contentType: string): Promise<boolean>
  download(bucket: string, path: string): Promise<string>
  remove(bucket: string, paths: string[]): Promise<void>
  exists(bucket: string, path: string): Promise<boolean>
}
export function storageCapability(options: StorageOptions): OperationCapability {
  if (['storage-buckets', 'storage-list', 'storage-download'].includes(options.operation)) return 'storage.read'
  if (options.operation === 'storage-upload') return 'storage.write'
  if (options.operation === 'storage-remove') return 'storage.delete'
  return 'storage.manage'
}
export async function runStorage(provider: StorageProvider, raw: StorageOptions): Promise<Record<string, unknown>> {
  const options = storageOptionsSchema.parse(raw)
  switch (options.operation) {
    case 'storage-buckets': return { items: await provider.buckets() }
    case 'storage-list': return { items: await provider.list(options.bucket, options.prefix, options.offset) }
    case 'storage-download': return { url: await provider.download(options.bucket, options.path), expiresIn: 60 }
    case 'storage-create-bucket':
    case 'storage-update-bucket': {
      await provider.configure(options.bucket, options, options.operation === 'storage-create-bucket')
      const bucket = (await provider.buckets()).find(item => item.id === options.bucket)
      if (!bucket || bucket.public !== options.public || Number(bucket.file_size_limit) !== options.maxBytes || JSON.stringify([...(Array.isArray(bucket.allowed_mime_types) ? bucket.allowed_mime_types : [])].sort()) !== JSON.stringify([...options.mimeTypes].sort())) throw new OperationError('Configuração do armazenamento ainda não confirmada.')
      return { verified: true, bucket: options.bucket }
    }
    case 'storage-delete-bucket':
      if ((await provider.list(options.bucket, '', 0)).length) throw new OperationError('Este espaço contém arquivos. Exclua somente os arquivos desejados antes de remover o espaço.')
      await provider.deleteBucket(options.bucket)
      if ((await provider.buckets()).some(item => item.id === options.bucket)) throw new OperationError('Remoção do espaço ainda não confirmada.')
      return { verified: true, bucket: options.bucket }
    case 'storage-upload':
      if (Buffer.from(options.content, 'base64').length > 512_000) throw new OperationError('Este envio aceita arquivos de até 512 KB.', 413)
      if (await provider.exists(options.bucket, options.path)) throw new OperationError('Já existe um arquivo com esse nome. Escolha outro caminho; arquivos existentes não são sobrescritos.')
      await provider.upload(options.bucket, options.path, options.content, options.contentType)
      if (!await provider.verifyUpload(options.bucket, options.path, options.content, options.contentType)) throw new OperationError('O conteúdo enviado ainda não foi confirmado pelo armazenamento.')
      return { verified: true, contentVerified: true, bucket: options.bucket, path: options.path }
    case 'storage-remove':
      await provider.remove(options.bucket, options.paths)
      for (const path of options.paths) if (await provider.exists(options.bucket, path)) throw new OperationError('A remoção ainda não foi confirmada.')
      return { verified: true, bucket: options.bucket, removed: options.paths.length }
  }
}
