import type { OperationCapability, OperationState } from './contract'

export const capabilityLabels: Record<OperationCapability, string> = {
  'data.read': 'Consultar dados', 'data.insert': 'Criar registros', 'data.update': 'Editar registros', 'data.upsert': 'Criar ou atualizar registros', 'data.delete': 'Excluir registros delimitados',
  'schema.migrate': 'Aplicar migrations verificadas', 'auth.read': 'Consultar contas', 'auth.configure': 'Configurar autenticação', 'auth.users': 'Administrar contas', 'auth.invite': 'Enviar convites por email', 'auth.roles': 'Atribuir papéis', 'auth.sessions': 'Encerrar sessões',
  'functions.read': 'Consultar funções', 'functions.deploy': 'Publicar funções', 'functions.remove': 'Remover funções', 'functions.hooks': 'Configurar envio de autenticação',
  'jobs.read': 'Consultar agendamentos', 'jobs.manage': 'Administrar agendamentos', 'jobs.run': 'Executar tarefa agora',
  'storage.read': 'Consultar arquivos', 'storage.manage': 'Administrar espaços de arquivos', 'storage.write': 'Enviar arquivos', 'storage.delete': 'Excluir arquivos',
  'integrations.read': 'Consultar integrações', 'integrations.configure': 'Configurar integrações', 'integrations.invoke': 'Executar integrações', 'credentials.use': 'Usar credenciais protegidas',
  'engine.update': 'Atualizar ferramentas do motor', 'engine.repair': 'Reparar falhas dentro do escopo autorizado',
}
export const operationStateLabels: Record<OperationState, string> = { queued: 'Registrada', running: 'Executando', verifying: 'Conferindo resultado', succeeded: 'Concluída', failed: 'Falhou antes do envio', uncertain: 'Resultado a confirmar', cancelled: 'Cancelada' }
