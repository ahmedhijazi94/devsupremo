import { z } from 'zod'

export const capabilities = [
  'data.read', 'data.insert', 'data.update', 'data.upsert', 'data.delete', 'schema.migrate',
  'auth.read', 'auth.configure', 'auth.users', 'auth.roles', 'auth.sessions',
  'functions.read', 'functions.deploy', 'functions.remove', 'functions.hooks',
  'jobs.read', 'jobs.manage', 'jobs.run', 'storage.read', 'storage.manage', 'storage.write', 'storage.delete',
  'integrations.read', 'integrations.configure', 'integrations.invoke', 'credentials.use', 'engine.update', 'engine.repair',
] as const
export const capabilitySchema = z.enum(capabilities)
export type OperationCapability = z.infer<typeof capabilitySchema>
export const environmentSchema = z.enum(['development', 'production'])
export const policyInputSchema = z.object({
  projectId: z.string().uuid(), environment: environmentSchema,
  expectedRevision: z.string().uuid().nullable(),
  enabled: z.boolean(), capabilities: z.array(capabilitySchema).max(capabilities.length),
  maxRows: z.number().int().min(1).max(1000), maxOperationsPerHour: z.number().int().min(1).max(1000),
  resources: z.array(z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9_.:/@-]+$/)).max(100),
  deviceIds: z.array(z.string().uuid()).max(50),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.capabilities).size !== value.capabilities.length) ctx.addIssue({ code: 'custom', message: 'Capacidades repetidas.' })
})
export type PolicyInput = z.infer<typeof policyInputSchema>
export interface OperationPolicy extends Omit<PolicyInput, 'expectedRevision' | 'projectId'> {
  id: string; projectId: string; ownerId: string; revision: string
}
export const operationStates = ['queued', 'running', 'verifying', 'succeeded', 'failed', 'uncertain', 'cancelled'] as const
export type OperationState = typeof operationStates[number]
export interface OperationReceipt {
  id: string; capability: OperationCapability; environment: 'development' | 'production'
  state: OperationState; updatedAt: string; message: string; result: Record<string, unknown> | null
}
export class OperationError extends Error {
  constructor(message: string, public readonly status = 409) { super(message); this.name = 'OperationError' }
}

export const developmentCapabilities: OperationCapability[] = [
  'data.read', 'data.insert', 'data.update', 'data.upsert', 'data.delete', 'schema.migrate',
  'auth.read', 'auth.configure', 'auth.users', 'auth.roles', 'auth.sessions',
  'functions.read', 'functions.deploy', 'functions.remove', 'functions.hooks',
  'jobs.read', 'jobs.manage', 'jobs.run', 'storage.read', 'storage.manage', 'storage.write', 'storage.delete',
  'integrations.read', 'integrations.configure', 'integrations.invoke', 'credentials.use', 'engine.update', 'engine.repair',
]
