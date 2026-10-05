'use client'

import { useEffect, useState } from 'react'
import { approveIntegrationProposal, approveIntegrationWithKey, approveOAuthIntegrationProposal, disconnectIntegration, getIntegrations } from '@/actions/integrations'
import { getProjectCredentials, type ProjectCredentialView } from '@/actions/secrets'
import type { IntegrationConnection, IntegrationReceipt } from '@/lib/integrations/contract'
import type { ConnectionProposal } from '@/lib/provider-connections/proposals-contract'

const environments = { development: 'Desenvolvimento', production: 'Produção' }
const statuses = { running: 'Em andamento', verifying: 'Aguardando confirmação', completed: 'Efeito conferido', outcome_unknown: 'Resultado incerto', failed: 'Falhou' }
const providers = { resend: 'Resend', 'stripe-test': 'Stripe · testes', github: 'GitHub', generic: 'API personalizada' }

export function BackendIntegrationsManager({ projectId }: { projectId: string }) {
  return <IntegrationManager key={projectId} projectId={projectId} />
}
function IntegrationManager({ projectId }: { projectId: string }) {
  const [connections, setConnections] = useState<IntegrationConnection[]>([]), [sessions, setSessions] = useState<IntegrationReceipt[]>([])
  const [proposals, setProposals] = useState<ConnectionProposal[]>([]), [credentials, setCredentials] = useState<ProjectCredentialView[]>([])
  const [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true, busy = false
    const refresh = async () => {
      if (busy) return
      busy = true
      try {
        const [integrations, vault] = await Promise.all([getIntegrations(projectId), getProjectCredentials(projectId)])
        if (!active) return
        if (!integrations.ok) setError(integrations.error)
        else {
          setConnections(integrations.connections); setSessions(integrations.sessions); setProposals(integrations.proposals)
          setCredentials(vault.credentials ?? []); setError(vault.error ?? null)
        }
      } catch { if (active) setError('Não foi possível atualizar as integrações. Tente novamente.') }
      finally { busy = false; if (active) setLoading(false) }
    }
    void refresh()
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 10000)
    return () => { active = false; window.clearInterval(interval) }
  }, [projectId, revision])
  return <section id="integrations" aria-label="Integrações" className="space-y-3 rounded-[var(--radius-inner)] bg-surface p-4">
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">Integrações</h3><button type="button" onClick={() => setRevision(value => value + 1)} className="text-xs underline">Atualizar</button></div>
    <p className="text-muted text-xs">Seu agente prepara a conexão. Confira o destino e autorize aqui; as chaves ficam no cofre, fora do chat.</p>
    {loading && <p role="status" className="text-muted text-xs">Carregando…</p>}
    {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
    {!loading && !proposals.length && !connections.length && !error && <p className="text-muted text-xs">Peça ao agente para preparar a integração desejada. O pedido aparecerá aqui.</p>}
    {proposals.filter(proposal => proposal.status === 'pending').map(proposal => <ProposalForm key={proposal.id} projectId={projectId} proposal={proposal} credentials={credentials} onDone={() => setRevision(value => value + 1)} />)}
    {connections.length > 0 && <ul className="space-y-2">{connections.map(connection => <li key={connection.id}><ConnectionRow projectId={projectId} connection={connection} onDone={() => setRevision(value => value + 1)} /></li>)}</ul>}
    {sessions.length > 0 && <div className="border-t border-current/10 pt-3"><h4 className="mb-2 text-xs font-semibold">Resultados recentes</h4><ul className="space-y-2">{sessions.slice(0, 8).map(session => <li key={session.operationId} className="text-xs">
      <p>{statuses[session.status]} · {session.operation === 'resend-send-test' ? 'Teste de email' : session.operation === 'stripe-create-test-product' ? 'Produto de teste' : 'Consulta ou configuração'}</p>
      {session.operation === 'resend-send-test' && <p className="text-muted">{session.evidence.messageDelivered === true ? 'O provedor confirmou a entrega.' : 'A entrega final ainda não foi confirmada.'}</p>}
      {session.operation === 'stripe-create-test-product' && <p className="text-muted">Produto sandbox. Nenhum pagamento foi confirmado por este teste.</p>}
      {typeof session.evidence.message === 'string' && <p className="text-muted">{session.evidence.message}</p>}
      {session.status === 'outcome_unknown' && <p className="text-muted">O agente deve consultar este mesmo pedido antes de tentar outra alteração.</p>}
    </li>)}</ul></div>}
  </section>
}
function ProposalForm({ projectId, proposal, credentials, onDone }: { projectId: string; proposal: ConnectionProposal; credentials: ProjectCredentialView[]; onDone(): void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [credentialId, setCredentialId] = useState(proposal.input.credentialId ?? '')
  const input = proposal.input
  async function approve(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return
    const form = event.currentTarget, value = new FormData(form).get('value')
    form.reset(); setBusy(true); setError(null)
    try {
      if (input.oauth) {
        const result = await approveOAuthIntegrationProposal({ projectId, proposalId: proposal.id })
        if (!result.ok) { setError(result.error); return }
        window.location.assign(result.authorizationUrl)
      } else {
        const result = credentialId ? await approveIntegrationProposal({ projectId, proposalId: proposal.id, credentialId })
          : await approveIntegrationWithKey({ projectId, proposalId: proposal.id, value: typeof value === 'string' ? value : '' })
        if (!result.ok) { setError(result.error); return }
        onDone()
      }
    } catch { setError('Autorização não confirmada. Atualize o estado antes de tentar novamente.') }
    finally { setBusy(false) }
  }
  return <form onSubmit={event => void approve(event)} className="space-y-2 rounded-[var(--radius-control)] bg-sunken p-3 text-xs">
    <p className="font-medium">{input.oauth?.providerKey ?? providers[input.provider]} · {environments[input.environment]}</p>
    {input.contract && <><p className="break-all">Destino: {input.contract.origin}</p><p className="break-all">Conta: {input.contract.identity.account}</p><p>Permissões: {input.contract.operations.map(operation => `${({ GET: 'consultar', POST: 'criar', PATCH: 'alterar', DELETE: 'remover' } as const)[operation.method]} ${operation.name}`).join('; ')}.</p></>}
    {input.provider === 'resend' && <><p>Remetentes: {input.allowedSenders.join(', ') || 'Nenhum'}</p><p>Destinatários de teste: {input.allowedRecipients.join(', ') || 'Nenhum'}</p></>}
    {input.provider === 'stripe-test' && <p>Permite criar e consultar produtos de teste. Não autoriza cobranças.</p>}
    {input.provider === 'github' && <p>Repositórios: {input.allowedRepositories.join(', ') || 'Nenhum'}</p>}
    {input.oauth ? <><p>Permissões solicitadas à conta: {input.oauth.scopes.join(', ')}</p><p className="text-muted break-all">Você continuará em {input.oauth.authorization.origin} para conceder acesso. O destino das credenciais é {input.oauth.token.origin}.</p></> : <>
      {!input.credentialId && <label className="block space-y-1"><span>Credencial</span><select value={credentialId} onChange={event => setCredentialId(event.target.value)} disabled={busy} className="w-full rounded bg-surface p-2"><option value="">Colar uma chave neste campo seguro</option>{credentials.filter(credential => credential.environment === input.environment).map(credential => <option key={credential.id} value={credential.id}>{credential.name} · cofre</option>)}</select></label>}
      {input.credentialId && <p>Será usada a credencial já indicada no cofre. O valor não será exibido.</p>}
      {!credentialId && <label className="block space-y-1"><span>Chave da integração</span><input name="value" type="password" autoComplete="new-password" spellCheck={false} maxLength={16384} required disabled={busy} className="w-full rounded bg-surface p-2" /><span className="text-muted block">Será guardada criptografada neste projeto para os próximos pedidos.</span></label>}
    </>}
    {error && <p role="alert" className="text-red-600">{error}</p>}
    <button type="submit" disabled={busy} className="rounded bg-accent px-3 py-2 font-medium text-accent-ink disabled:opacity-50">{busy ? 'Autorizando…' : input.oauth ? 'Autorizar conta' : 'Autorizar conexão'}</button>
  </form>
}
function ConnectionRow({ projectId, connection, onDone }: { projectId: string; connection: IntegrationConnection; onDone(): void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  async function disconnect() {
    if (busy) return
    setBusy(true); setError(null)
    try { const result = await disconnectIntegration({ projectId, connectionId: connection.id }); if (!result.ok) setError(result.error); else onDone() }
    catch { setError('Desvinculação não confirmada. Atualize o estado.') }
    finally { setBusy(false) }
  }
  return <div className="rounded bg-sunken p-2 text-xs"><p>{providers[connection.provider]} · {environments[connection.environment]} · {connection.revokedAt ? 'Desvinculada' : 'Conectada'}</p>
    <p className="text-muted break-all">{connection.contract?.origin ?? (connection.accountIdentityVerified ? connection.accountRef : 'A chave identifica esta autorização; a conta não pôde ser consultada no provedor.')}</p>
    {!connection.revokedAt && <button type="button" disabled={busy} onClick={() => void disconnect()} className="mt-1 underline disabled:opacity-50">{busy ? 'Desvinculando…' : 'Desvincular do Supremo'}</button>}
    <p className="text-muted mt-1">Desvincular bloqueia novos usos aqui. A chave e os recursos no provedor continuam existentes.</p>{error && <p role="alert">{error}</p>}
  </div>
}
