import { z } from 'zod'

export const sqlArtifactStates = ['prepared', 'materializing', 'materialized', 'applying', 'applied', 'succeeded', 'uncertain', 'failed', 'conflict'] as const
export const artifactPathSchema = z.string().regex(/^supabase\/migrations\/\d{14}_[a-f0-9]{32}\.sql$/)
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const sqlArtifactSchema = z.object({ id: z.string().uuid(), projectId: z.string().uuid(), projectRef: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  environment: z.literal('development'), path: artifactPathSchema, content: z.string().min(1).max(250_000), digest: digestSchema,
  state: z.enum(sqlArtifactStates), claimToken: z.string().uuid().nullable(), message: z.string(),
  types: z.object({ path: z.string().regex(/^supabase\/types\/\d{14}_[a-f0-9]{32}\.types\.ts$/), content: z.string().max(2_000_000), digest: digestSchema }).nullable(),
  updatedAt: z.string() }).strict()
export type SqlArtifact = z.infer<typeof sqlArtifactSchema>
export type SqlArtifactSummary = Pick<SqlArtifact, 'id' | 'path' | 'state' | 'message' | 'updatedAt'>
export const prepareSqlArtifactSchema = z.object({ projectId: z.string().uuid(), expectedRef: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  content: z.string().trim().min(1).max(250_000) }).strict()
const identity = { projectId: z.string().uuid(), expectedRef: z.string().regex(/^[a-z0-9_-]{1,64}$/), deviceSecret: z.string().min(10).max(256) }
const claimed = { ...identity, id: z.string().uuid(), claimToken: z.string().uuid() }
export const sqlArtifactRequestSchema = z.discriminatedUnion('operation', [
  z.object({ ...identity, operation: z.literal('poll'), sessionId: z.string().uuid(), ready: z.boolean() }).strict(),
  z.object({ ...claimed, operation: z.literal('materialized'), digest: digestSchema }).strict(),
  z.object({ ...claimed, operation: z.literal('advance') }).strict(),
  z.object({ ...claimed, operation: z.literal('completed'), typesDigest: digestSchema }).strict(),
  z.object({ ...claimed, operation: z.literal('conflict') }).strict(),
])
export class SqlArtifactError extends Error {
  constructor(message: string, public status = 409) { super(message); this.name = 'SqlArtifactError' }
}
