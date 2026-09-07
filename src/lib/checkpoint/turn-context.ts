import { z } from 'zod'
import { feedbackEnvelopeSchema } from './feedback'

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/)
const environmentSchema = z.enum(['development', 'production', 'unknown'])

export const turnContextRequestSchema = z.object({
  deviceSecret: z.string().min(10).max(256),
  projectId: z.string().uuid(),
}).strict()

/** Backend observations only; the local host adds ref, preview and worker state. */
export const backendTurnContextSchema = z.object({
  version: z.literal(1),
  projectId: z.string().uuid(),
  project: z.object({ id: z.string().uuid(), name: z.string() }),
  repository: z.object({
    fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    url: z.string().url(),
    branch: z.string().min(1),
    defaultBranch: z.string().min(1),
  }),
  environment: environmentSchema,
  databaseEnvironment: environmentSchema,
  databaseAuthority: z.object({
    projectRef: z.string().nullable(),
    source: z.literal('supremo_provisioned').nullable(),
    automaticMigrations: z.boolean(),
  }),
  latestCheckpoint: z.object({
    id: z.string().uuid(),
    localSha: shaSchema,
    publishedSha: shaSchema.nullable(),
    pushStatus: z.enum(['publishing', 'published', 'integrated']),
    integrationStatus: z.string().nullable(),
    integrationBranch: z.string().nullable(),
    createdAt: z.string().datetime(),
  }).nullable(),
  feedback: feedbackEnvelopeSchema,
  observedAt: z.string().datetime(),
}).superRefine((context, validation) => {
  if (context.project.id !== context.projectId) {
    validation.addIssue({ code: 'custom', message: 'Project identity mismatch.' })
  }
  const authority = context.databaseAuthority
  if (context.databaseEnvironment !== context.environment ||
    (authority.automaticMigrations && (context.environment !== 'development' || !authority.projectRef || !authority.source))) {
    validation.addIssue({ code: 'custom', message: 'Database authority mismatch.' })
  }
  for (const feedback of [context.feedback.current, context.feedback.previousFailure]) {
    if (feedback && feedback.projectId !== context.projectId) {
      validation.addIssue({ code: 'custom', message: 'Feedback project mismatch.' })
    }
  }
  const current = context.feedback.current
  const latest = context.latestCheckpoint
  if (current && (!latest || current.checkpointId !== latest.id || current.commitSha !== latest.localSha || current.publishedSha !== latest.publishedSha)) {
    validation.addIssue({ code: 'custom', message: 'Feedback checkpoint or SHA mismatch.' })
  }
  // Reconciliation persists a failed integration before collecting detailed
  // logs. That window is not a clean preflight: wait for the evidence worker.
  if (latest && ['ci_failed', 'security_blocked'].includes(latest.integrationStatus ?? '') && current?.state !== 'failed') {
    validation.addIssue({ code: 'custom', message: 'Known validation failure is awaiting diagnostic evidence.' })
  }
  if (context.feedback.previousFailure && context.feedback.previousFailure.state !== 'failed') {
    validation.addIssue({ code: 'custom', message: 'Recovery requires failure evidence.' })
  }
})

export type BackendTurnContext = z.infer<typeof backendTurnContextSchema>
