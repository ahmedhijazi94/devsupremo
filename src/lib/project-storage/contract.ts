import { z } from 'zod'
export const storageBucketSchema = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9_.-]*$/)
export const storagePathSchema = z.string().min(1).max(512).refine(value => !/[\x00-\x1f\\?#%]/.test(value) && !value.startsWith('/') && value.split('/').every(part => part !== '..' && part !== '.' && part.length > 0), 'Caminho inválido.')
const base = { environment: z.enum(['development', 'production']), expectedRef: z.string().regex(/^[a-z0-9]{1,64}$/) }
const write = { ...base, operationId: z.string().uuid() }
const bucketSettings = { public: z.boolean().default(false), maxBytes: z.number().int().min(1).max(50_000_000).default(5_000_000), mimeTypes: z.array(z.string().regex(/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/)).min(1).max(20) }
export const storageOptionsSchema = z.discriminatedUnion('operation', [
  z.object({ ...base, operation: z.literal('storage-buckets') }).strict(),
  z.object({ ...base, operation: z.literal('storage-list'), bucket: storageBucketSchema, prefix: z.union([z.literal(''), storagePathSchema]).default(''), offset: z.number().int().min(0).max(10000).default(0) }).strict(),
  z.object({ ...write, operation: z.literal('storage-create-bucket'), bucket: storageBucketSchema, ...bucketSettings }).strict(),
  z.object({ ...write, operation: z.literal('storage-update-bucket'), bucket: storageBucketSchema, ...bucketSettings }).strict(),
  z.object({ ...write, operation: z.literal('storage-delete-bucket'), bucket: storageBucketSchema }).strict(),
  z.object({ ...write, operation: z.literal('storage-upload'), bucket: storageBucketSchema, path: storagePathSchema,
    contentType: z.string().regex(/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/), content: z.string().min(4).max(700_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
  z.object({ ...base, operation: z.literal('storage-download'), bucket: storageBucketSchema, path: storagePathSchema }).strict(),
  z.object({ ...write, operation: z.literal('storage-remove'), bucket: storageBucketSchema, paths: z.array(storagePathSchema).min(1).max(25) }).strict(),
])
export type StorageOptions = z.infer<typeof storageOptionsSchema>
export const storageRequestSchema = z.object({ projectId: z.string().uuid(), deviceSecret: z.string().min(10).max(256), options: storageOptionsSchema }).strict()
