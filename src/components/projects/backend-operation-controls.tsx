'use client'
import { useEffect, useState } from 'react'
import { getProjectAutomation } from '@/actions/automation'
import { administerProjectBackend } from '@/actions/backend-administration'
import { BackendFunctions, BackendUsers } from './backend-panels'
import { backendButton, backendField } from './backend-resource'
import { browserOperation } from '@/lib/project-backend/browser-operation'
import { BackendAuthProvider } from './backend-auth-provider'

function OperationControls({ projectId, kind }: { projectId: string; kind: 'auth' | 'function' }) {
  const [target, setTarget] = useState<{ expectedRef: string; environment: 'development' | 'production' } | null>(null)
  const [operation, setOperation] = useState(kind === 'auth' ? 'auth-role-set' : 'functions-hook-configure')
  const [userId, setUserId] = useState(''), [email, setEmail] = useState(''), [roles, setRoles] = useState('')
  const [redirectTo, setRedirectTo] = useState('')
  const [slug, setSlug] = useState(''), [replaceSlug, setReplaceSlug] = useState(''), [version, setVersion] = useState(1), [previousVersion, setPreviousVersion] = useState(1)
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { let active = true; void getProjectAutomation(projectId).then(result => {
    if (!active) return
    if (result.ok && result.environment !== 'unknown' && result.projectRef) setTarget({ environment: result.environment, expectedRef: result.projectRef })
    else setMessage(result.ok ? 'O ambiente ainda não foi confirmado.' : result.error)
  }).catch(() => { if (active) setMessage('Não foi possível consultar o ambiente. Atualize para tentar novamente.') }); return () => { active = false } }, [projectId])
  return <details className="mt-5 rounded-xl border p-4"><summary className="cursor-pointer text-sm font-medium">{kind === 'auth' ? 'Administrar contas e acesso' : 'Administrar função e envio de autenticação'}</summary>
    <form className="mt-4 space-y-3" onSubmit={async event => {
      event.preventDefault(); if (!target || busy) return; setBusy(true); setMessage('')
      const recipient = operation === 'auth-invite' ? email : null
      const report = (text: string) => setMessage(recipient ? `Convite para ${recipient}: ${text}` : text)
      let options: Record<string, unknown>
      if (kind === 'auth') {
        options = { operation, environment: target.environment, ...(['auth-create', 'auth-invite'].includes(operation) ? { email } : { userId }),
          ...(operation === 'auth-create' ? { emailConfirmed: false } : {}),
          ...(operation === 'auth-invite' && redirectTo ? { redirectTo } : {}),
          ...(operation === 'auth-role-set' ? { roles: roles.split(',').map(value => value.trim()).filter(Boolean), manifestVersion: 1 } : {}),
          ...(operation === 'auth-update' ? { user: { banHours: 24 } } : {}) }
      } else options = { operation, environment: target.environment, slug,
        ...(operation === 'functions-hook-configure' ? { secretName: 'AUTH_SEND_EMAIL_HOOK_SECRET', ...(replaceSlug ? { replaceSlug } : {}) } : {}),
        ...(['functions-remove', 'functions-rollback'].includes(operation) ? { expectedVersion: version } : {}),
        ...(operation === 'functions-rollback' ? { version: previousVersion } : {}) }
      try {
        const attempt = await browserOperation(projectId, { expectedRef: target.expectedRef, kind, options })
        const result = await administerProjectBackend({ projectId, expectedRef: target.expectedRef, operationId: attempt.id, kind, options })
        if (!result.ok) report(result.error)
        else {
          const data = result.data as { receipt?: { message: string; state: string } }
          if (data.receipt?.state === 'succeeded' || kind === 'function') attempt.confirmed()
          report(recipient && data.receipt?.state === 'succeeded'
            ? 'Aceito pelo provedor e conta conferida. A entrega do email ainda não foi comprovada.'
            : data.receipt?.message ?? 'Operação verificada no provedor. Atualize a consulta acima para conferir o estado.')
        }
      } catch { report('Conexão interrompida. Confira o resultado antes de repetir a operação.') }
      finally { setBusy(false) }
    }}>
      <label className="block text-sm">Ação<select className={backendField} disabled={busy} value={operation} onChange={event => setOperation(event.target.value)}>
        {kind === 'auth' ? <><option value="auth-role-set">Definir papéis da aplicação</option><option value="auth-sessions-revoke">Encerrar sessões de renovação</option><option value="auth-invite">Convidar por email</option><option value="auth-create">Criar conta sem senha</option><option value="auth-update">Suspender conta por 24 horas</option><option value="auth-delete">Excluir conta</option></> : <><option value="functions-hook-configure">Conectar envio de autenticação</option><option value="functions-hook-disable">Desativar envio por esta função</option><option value="functions-rollback">Restaurar versão anterior</option><option value="functions-remove">Remover função sem dependências</option></>}
      </select></label>
      {kind === 'auth' ? <>
        {['auth-create', 'auth-invite'].includes(operation) ? <label className="block text-sm">Email<input type="email" className={backendField} disabled={busy} value={email} onChange={event => setEmail(event.target.value)} required /></label> : <label className="block text-sm">ID da conta exibido na tabela<input className={backendField} disabled={busy} value={userId} onChange={event => setUserId(event.target.value)} required /></label>}
        {operation === 'auth-invite' && <label className="block text-sm">URL após aceitar o convite (opcional)<input type="url" className={backendField} disabled={busy} value={redirectTo} onChange={event => setRedirectTo(event.target.value)} /><span className="text-muted text-xs">Use uma URL já configurada na autenticação do projeto.</span></label>}
        {operation === 'auth-role-set' && <label className="block text-sm">Papéis, separados por vírgula (vazio remove os papéis)<input className={backendField} disabled={busy} value={roles} onChange={event => setRoles(event.target.value)} placeholder="master" /></label>}
      </> : <>
        <label className="block text-sm">Nome da função<input className={backendField} disabled={busy} value={slug} onChange={event => setSlug(event.target.value)} required /></label>
        {operation === 'functions-hook-configure' && <label className="block text-sm">Função atual a substituir, se houver<input className={backendField} disabled={busy} value={replaceSlug} onChange={event => setReplaceSlug(event.target.value)} /></label>}
        {['functions-remove', 'functions-rollback'].includes(operation) && <label className="block text-sm">Versão atual<input type="number" min={1} disabled={busy} value={version} onChange={event => setVersion(Number(event.target.value))} className={backendField} /></label>}
        {operation === 'functions-rollback' && <label className="block text-sm">Versão a restaurar<input type="number" min={1} disabled={busy} value={previousVersion} onChange={event => setPreviousVersion(Number(event.target.value))} className={backendField} /></label>}
      </>}
      <button className={backendButton} disabled={busy || !target} type="submit">{busy ? 'Executando…' : 'Aplicar ao recurso indicado'}</button>
      {message && <p role="status" className="text-sm">{message}</p>}
    </form>
  </details>
}
export function BackendUsersManager({ projectId }: { projectId: string }) { return <><BackendUsers projectId={projectId} /><OperationControls projectId={projectId} kind="auth" /><BackendAuthProvider projectId={projectId} /></> }
export function BackendFunctionsManager({ projectId }: { projectId: string }) { return <><BackendFunctions projectId={projectId} /><OperationControls projectId={projectId} kind="function" /></> }
