'use client'

import { useEffect, useState } from 'react'
import { decideProjectOperationApproval, getProjectOperationApprovals } from '@/actions/operation-approvals'
import type { OperationApproval } from '@/lib/backend-operations/approval-contract'
import { capabilityLabels } from '@/lib/backend-operations/presentation'

const labels:Record<OperationApproval['status'],string>={pending:'Aguardando decisão',approved:'Autorizada para uma execução',consumed:'Execução reservada',rejected:'Recusada',revoked:'Revogada'}
export function OperationApprovalsPanel({projectId}:{projectId:string}){
  const [approvals,setApprovals]=useState<OperationApproval[]>([]),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[observedAt,setObservedAt]=useState(0)
  async function refresh(){
    try{const result=await getProjectOperationApprovals(projectId);if(result.ok){setApprovals(result.approvals);setObservedAt(Date.parse(result.observedAt))}else setMessage(result.error)}catch{setMessage('Não foi possível atualizar as aprovações.')}
  }
  useEffect(()=>{let active=true;void getProjectOperationApprovals(projectId).then(result=>{if(active){if(result.ok){setApprovals(result.approvals);setObservedAt(Date.parse(result.observedAt))}else setMessage(result.error)}}).catch(()=>{if(active)setMessage('Não foi possível carregar as aprovações.')});return()=>{active=false}},[projectId])
  async function decide(approvalId:string,decision:'approved'|'rejected'|'revoked'){
    setBusy(true);setMessage('')
    try{const result=await decideProjectOperationApproval({projectId,approvalId,decision});setMessage(result.ok?decision==='approved'?'Pedido autorizado. O agente pode retomar a mesma operação.':'Decisão registrada.':result.error);await refresh()}catch{setMessage('Resposta não confirmada. Atualize para conferir sua decisão.')}finally{setBusy(false)}
  }
  return <section className="space-y-3 border-t pt-4" aria-label="Aprovações pontuais">
    <div className="flex justify-between"><h3 className="font-medium">Aprovar apenas este pedido</h3><button type="button" onClick={()=>void refresh()} className="text-sm underline" disabled={busy}>Atualizar pedidos</button></div>
    <p className="text-muted text-sm">Esta autorização vale somente para o pedido e destino mostrados, até o prazo indicado. Os limites e as permissões permanentes do projeto continuam iguais.</p>
    {message&&<p role="status" className="text-sm">{message}</p>}
    {approvals.length===0?<p className="text-muted text-sm">Nenhum pedido de aprovação pontual.</p>:<ul className="space-y-3">{approvals.map(approval=>{
      const expired=Date.parse(approval.expiresAt)<=observedAt
      return <li key={approval.id} className="rounded-xl border p-3 text-sm">
        <p className="font-medium">{capabilityLabels[approval.capability]} · {expired?'Prazo encerrado':labels[approval.status]}</p>
        <p className="break-words">{approval.environment==='development'?'Desenvolvimento':'Produção'} · Destino: {approval.projectRef||'Projeto conectado'}{approval.resource?` · Recurso: ${approval.resource}`:''}</p>
        {approval.rows!==null&&<p>Limite deste pedido: {approval.rows} registro(s).</p>}
        <p>Prazo: {new Date(approval.expiresAt).toLocaleString('pt-BR')}</p>
        <details className="my-2"><summary>Conferir o pedido exato</summary><dl className="mt-2 space-y-1">{approval.review.map((entry,index)=><div key={index} className="break-words"><dt className="font-medium">{entry.label}</dt><dd>{entry.value}</dd></div>)}</dl><p className="mt-2 break-all text-xs">Pedido: {approval.operationId}</p><p className="break-all text-xs">Identificador do conteúdo: {approval.inputDigest}</p></details>
        {!expired&&approval.status==='pending'&&<div className="flex gap-2"><button type="button" disabled={busy} onClick={()=>void decide(approval.id,'approved')} className="bg-accent text-accent-ink rounded-lg px-3 py-2">Autorizar este pedido</button><button type="button" disabled={busy} onClick={()=>void decide(approval.id,'rejected')} className="rounded-lg border px-3 py-2">Recusar</button></div>}
        {!expired&&['approved','consumed'].includes(approval.status)&&<button type="button" disabled={busy} onClick={()=>void decide(approval.id,'revoked')} className="rounded-lg border px-3 py-2">Revogar autorização</button>}
      </li>
    })}</ul>}
  </section>
}
