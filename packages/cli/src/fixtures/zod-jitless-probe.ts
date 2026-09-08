import '../zod-config'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { jobsManifestSchema } from '../../../../src/lib/database-jobs/policy'
import { secretRequestOptionsSchema } from '../project-service-request'

assert.equal(z.config().jitless, true)
let attempts = 0
const originalFunction = globalThis.Function
// Also count attempts: Node's flag alone could conceal a caught eval probe.
globalThis.Function = new Proxy(originalFunction, {
  construct() {
    attempts++
    throw new Error('Dynamic code generation forbidden in CLI validation')
  },
  apply() {
    attempts++
    throw new Error('Dynamic code generation forbidden in CLI validation')
  },
})
try {
  const keys = [
    '</script><script>throw new Error(1)</script>',
    'x";throw new Error(2);//',
    "x'];throw new Error(3);//",
    'line\u2028separator\u2029',
    '__proto__',
    'constructor',
  ]
  for (const key of keys) {
    // Prototype keys are rejected by strict validation; they cannot write a
    // prototype or execute text. Every other string remains an ordinary key.
    if (key === '__proto__') {
      assert.equal(
        z
          .object({ allowed: z.string() })
          .strict()
          .safeParse(
            JSON.parse('{"allowed":"ok","__proto__":{"polluted":true}}'),
          ).success,
        false,
      )
      continue
    }
    const schema = z
      .object({
        [key]: z.string(),
        count: z.number().int().min(1),
        choice: z.enum(['open', 'closed']),
      })
      .strict()
    const payload = {
      [key]: '</script>\n";throw new Error(4);//',
      count: 1,
      choice: 'open',
    }
    assert.equal(schema.safeParse(payload).success, true)
    assert.equal(schema.safeParse({ ...payload, count: 0 }).success, false)
    assert.equal(
      schema.safeParse({ ...payload, choice: 'admin' }).success,
      false,
    )
  }
  const valid = {
    version: 1,
    jobs: [
      {
        id: 'overdue',
        schedule: '0 * * * *',
        timezone: 'UTC',
        action: {
          type: 'update',
          table: 'tickets',
          set: { status: 'overdue' },
          where: [{ column: 'status', op: 'eq', value: 'open' }],
        },
      },
    ],
  }
  assert.equal(jobsManifestSchema.safeParse(valid).success, true)
  assert.equal(
    jobsManifestSchema.safeParse({ ...valid, sql: 'RESET ROLE' }).success,
    false,
  )
  assert.equal(
    jobsManifestSchema.safeParse({
      version: 1,
      jobs: [
        {
          ...valid.jobs[0],
          action: { ...valid.jobs[0]!.action, set: { is_superuser: true } },
        },
      ],
    }).success,
    false,
  )
  assert.equal(
    secretRequestOptionsSchema.safeParse({
      requests: [
        {
          name: 'STRIPE_SECRET_KEY',
          description: 'Server integration',
          target: 'supabase',
          environment: 'development',
          value: 'forbidden',
        },
      ],
    }).success,
    false,
  )
  assert.equal(attempts, 0)
  console.log(
    JSON.stringify({
      jitless: true,
      dynamicCodeAttempts: attempts,
      maliciousKeysAndPayloads: 'checked',
      sharedProjectPolicies: 'checked',
    }),
  )
} finally {
  globalThis.Function = originalFunction
}
