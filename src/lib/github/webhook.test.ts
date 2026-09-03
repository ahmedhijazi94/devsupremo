import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  isSupremoIntegrationRef,
  parseWebhookForReconcile,
  verifyWebhookSignature,
} from './webhook'

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

  it('pull_request synchronize (branch supremo/) → alvo com a PR', () => {
    const t = parseWebhookForReconcile('pull_request', {
      action: 'synchronize',
      installation,
      repository: repo,
      pull_request: { number: 7, head: { sha: 'abc123', ref: 'supremo/cp-aaaa' } },
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
      pull_request: { number: 7, head: { ref: 'supremo/cp-aaaa' } },
    })
    expect(t).toBeNull()
  })

  /**
   * E2E real: Histórico preso em "Testando" mesmo com o projeto chegando a
   * READY. Causa: 'closed' nunca disparava reconciliation — o projeto só
   * chegava a 'merged' por COINCIDÊNCIA de algum check_suite/check_run
   * completar enquanto a PR ainda estava aberta. Sem um gatilho dedicado pra
   * "esta PR mergeou de verdade", reconciliar checkpoints (que só roda dentro
   * do MESMO ciclo que reconcilia o projeto) ficava refém dessa coincidência.
   */
  describe('pull_request closed — só quando CONFIRMADAMENTE mergeada (merged: true)', () => {
    it('closed COM merged:true → agora dispara reconciliation (o gatilho que faltava)', () => {
      const t = parseWebhookForReconcile('pull_request', {
        action: 'closed',
        installation,
        repository: repo,
        pull_request: {
          number: 7,
          merged: true,
          head: { sha: 'final-sha', ref: 'supremo/cp-aaaa' },
        },
      })
      expect(t).not.toBeNull()
      expect(t!.prNumbers).toEqual([7])
      expect(t!.action).toBe('closed')
    })

    it('closed SEM merge (PR abandonada/rejeitada) → continua null — nada a reconciliar, mesclar geraria erro à toa', () => {
      const t = parseWebhookForReconcile('pull_request', {
        action: 'closed',
        installation,
        repository: repo,
        pull_request: {
          number: 7,
          merged: false,
          head: { sha: 'abandoned-sha', ref: 'supremo/cp-aaaa' },
        },
      })
      expect(t).toBeNull()
    })

    it('closed sem o campo merged (payload malformado) → trata como não confirmado, null', () => {
      const t = parseWebhookForReconcile('pull_request', {
        action: 'closed',
        installation,
        repository: repo,
        pull_request: { number: 7, head: { ref: 'supremo/cp-aaaa' } },
      })
      expect(t).toBeNull()
    })

    it('closed+merged:true de PR fora do namespace supremo/ → continua null (isolamento preservado)', () => {
      const t = parseWebhookForReconcile('pull_request', {
        action: 'closed',
        installation,
        repository: repo,
        pull_request: {
          number: 42,
          merged: true,
          head: { ref: 'dependabot/npm_and_yarn/next-15.0.0' },
        },
      })
      expect(t).toBeNull()
    })
  })

  it('check_suite completed → PRs associadas (todas em branch supremo/)', () => {
    const t = parseWebhookForReconcile('check_suite', {
      action: 'completed',
      installation,
      repository: repo,
      check_suite: {
        head_sha: 'deadbeef',
        pull_requests: [
          { number: 3, head: { ref: 'supremo/cp-aaaa' } },
          { number: 5, head: { ref: 'supremo/cp-bbbb' } },
        ],
      },
    })
    expect(t!.prNumbers).toEqual([3, 5])
  })

  it('check_run completed → PRs via check_suite (branch supremo/)', () => {
    const t = parseWebhookForReconcile('check_run', {
      action: 'completed',
      installation,
      repository: repo,
      check_run: {
        check_suite: {
          head_sha: 'x',
          pull_requests: [{ number: 9, head: { ref: 'supremo/cp-cccc' } }],
        },
      },
    })
    expect(t!.prNumbers).toEqual([9])
  })

  describe('isolamento de PR de bot/externo — nunca contamina o Merge Controller', () => {
    it('isSupremoIntegrationRef: só aceita o namespace supremo/', () => {
      expect(isSupremoIntegrationRef('supremo/cp-aaaa')).toBe(true)
      expect(isSupremoIntegrationRef('dependabot/npm_and_yarn/next-15.0.0')).toBe(false)
      expect(isSupremoIntegrationRef('feature/minha-branch')).toBe(false)
      expect(isSupremoIntegrationRef('main')).toBe(false)
      expect(isSupremoIntegrationRef(null)).toBe(false)
    })

    it('PR do Dependabot (fora de supremo/) → null, NUNCA reconcilia nem contamina integration_state', () => {
      const t = parseWebhookForReconcile('pull_request', {
        action: 'opened',
        installation,
        repository: repo,
        pull_request: {
          number: 42,
          head: { sha: 'dep123', ref: 'dependabot/npm_and_yarn/next-15.0.0' },
        },
      })
      expect(t).toBeNull()
    })

    it('check_suite com PR de bot misturada → filtra só a de bot, mantém as do Supremo', () => {
      const t = parseWebhookForReconcile('check_suite', {
        action: 'completed',
        installation,
        repository: repo,
        check_suite: {
          head_sha: 'x',
          pull_requests: [
            { number: 3, head: { ref: 'supremo/cp-aaaa' } },
            { number: 99, head: { ref: 'dependabot/npm_and_yarn/foo' } },
          ],
        },
      })
      expect(t!.prNumbers).toEqual([3])
      expect(t!.prNumbers).not.toContain(99)
    })

    it('check_suite só com PRs de bot → null (nada relevante a reconciliar)', () => {
      const t = parseWebhookForReconcile('check_suite', {
        action: 'completed',
        installation,
        repository: repo,
        check_suite: {
          head_sha: 'x',
          pull_requests: [{ number: 99, head: { ref: 'dependabot/npm_and_yarn/foo' } }],
        },
      })
      expect(t).toBeNull()
    })
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
