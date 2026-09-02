import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseWebhookForReconcile, verifyWebhookSignature } from './webhook'

const SECRET = 'super-webhook-secret'
function sign(body: string, secret = SECRET): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

describe('verifyWebhookSignature', () => {
  const body = JSON.stringify({ hello: 'world' })

  it('aceita assinatura válida', () => {
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true)
  })

  it('rejeita assinatura de outro secret', () => {
    expect(verifyWebhookSignature(body, sign(body, 'outro'), SECRET)).toBe(false)
  })

  it('rejeita corpo adulterado (assinatura não bate)', () => {
    const sig = sign(body)
    expect(verifyWebhookSignature(body + 'x', sig, SECRET)).toBe(false)
  })

  it('rejeita header ausente, formato inválido e secret vazio', () => {
    expect(verifyWebhookSignature(body, null, SECRET)).toBe(false)
    expect(verifyWebhookSignature(body, 'md5=abc', SECRET)).toBe(false)
    expect(verifyWebhookSignature(body, sign(body), '')).toBe(false)
  })
})

describe('parseWebhookForReconcile — só dispara, não autoriza', () => {
  const repo = { full_name: 'ahmed/app' }
  const installation = { id: 42 }

  it('pull_request synchronize → alvo com a PR', () => {
    const t = parseWebhookForReconcile('pull_request', {
      action: 'synchronize',
      installation,
      repository: repo,
      pull_request: { number: 7, head: { sha: 'abc123' } },
    })
    expect(t).not.toBeNull()
    expect(t!.prNumbers).toEqual([7])
    expect(t!.repoFullName).toBe('ahmed/app')
    expect(t!.installationId).toBe(42)
    // o SHA do payload é só DICA, nunca autorização
    expect(t!.headShaHint).toBe('abc123')
  })

  it('pull_request com ação irrelevante → null', () => {
    const t = parseWebhookForReconcile('pull_request', {
      action: 'labeled',
      installation,
      repository: repo,
      pull_request: { number: 7 },
    })
    expect(t).toBeNull()
  })

  it('check_suite completed → PRs associadas', () => {
    const t = parseWebhookForReconcile('check_suite', {
      action: 'completed',
      installation,
      repository: repo,
      check_suite: { head_sha: 'deadbeef', pull_requests: [{ number: 3 }, { number: 5 }] },
    })
    expect(t!.prNumbers).toEqual([3, 5])
  })

  it('check_run completed → PRs via check_suite', () => {
    const t = parseWebhookForReconcile('check_run', {
      action: 'completed',
      installation,
      repository: repo,
      check_run: { check_suite: { head_sha: 'x', pull_requests: [{ number: 9 }] } },
    })
    expect(t!.prNumbers).toEqual([9])
  })

  it('workflow_run é IGNORADO (least privilege: evita exigir Actions:read)', () => {
    // Os jobs da CI já chegam por check_suite/check_run; workflow_run não traz
    // gatilho novo e pediria Actions:read. Deve retornar null.
    const t = parseWebhookForReconcile('workflow_run', {
      action: 'completed',
      installation,
      repository: repo,
      workflow_run: { head_sha: 'x', pull_requests: [{ number: 11 }] },
    })
    expect(t).toBeNull()
  })

  it('sem installation/repository → null (não dá para reler com segurança)', () => {
    expect(
      parseWebhookForReconcile('pull_request', {
        action: 'opened',
        repository: repo,
        pull_request: { number: 1 },
      }),
    ).toBeNull()
  })

  it('evento fora do conjunto → null (não faz nada)', () => {
    expect(
      parseWebhookForReconcile('push', { installation, repository: repo }),
    ).toBeNull()
    expect(
      parseWebhookForReconcile('check_suite', {
        action: 'requested',
        installation,
        repository: repo,
        check_suite: { pull_requests: [{ number: 1 }] },
      }),
    ).toBeNull()
  })
})
