/** Only this block belongs to the platform; surrounding instructions belong to the user. */
export const DEVELOPMENT_POLICY_START = '<!-- BEGIN:supremo-development-policy -->'
export const DEVELOPMENT_POLICY_END = '<!-- END:supremo-development-policy -->'

const POLICY = `${DEVELOPMENT_POLICY_START}
## Fluxo de desenvolvimento atual do Supremo

Este bloco atualiza somente os padrões de workflow gerados pelo Supremo, inclusive
quando há instruções antigas de testes/QA/recovery neste arquivo. Instruções explícitas
do usuário continuam tendo precedência; preserve as regras de arquitetura e segurança.

- Padrão: implemente o pedido, mantenha o preview disponível e deixe o usuário avaliar.
  Execute testes, QA de navegador, cobertura ou build de verificação somente se solicitado.
  Não crie contas nem dados de teste por rotina. O usuário pode optar por validação automática.
- Leia o contexto compacto do turno e apenas os arquivos necessários à alteração.
  Não examine o bundle da CLI, releia o repositório inteiro nem investigue o banco remoto
  para exibir um campo que já está presente no modelo e na consulta do app.
- Falhas anteriores de tipos/lint/testes continuam registradas; não exigem reparo antes
  de um novo pedido comum. Não declare a falha resolvida sem prova. Siga o guard atual
  para riscos de segurança, RLS, ambiente e migrations; nunca contorne autorização.
- Conclua o turno e registre o checkpoint mesmo com diagnóstico comum pendente.
  O daemon sincroniza o registro, verifica segredos antes de enviar código e encaminha
  a validação à CI. Capturado, publicado e aprovado são estados diferentes.
- Preserve processo, porta, ambiente e rascunhos do preview saudável. Não espere CI.
  Autenticação, autorização, RLS, validação no servidor e gates de integração permanecem.

Consulte .supremo/DEVELOPMENT.md somente quando precisar de detalhes do protocolo.
${DEVELOPMENT_POLICY_END}`

/** Refuse ambiguous markers rather than risk replacing custom instructions. */
export function withDevelopmentPolicy(content: string): string {
  const starts = content.split(DEVELOPMENT_POLICY_START).length - 1
  const ends = content.split(DEVELOPMENT_POLICY_END).length - 1
  if (starts === 0 && ends === 0) {
    return content + (content.endsWith('\n') ? '\n' : '\n\n') + POLICY + '\n'
  }
  if (starts !== 1 || ends !== 1) throw new Error('Bloco de política Supremo ambíguo; preserve as instruções e revise os marcadores.')
  const start = content.indexOf(DEVELOPMENT_POLICY_START)
  const end = content.indexOf(DEVELOPMENT_POLICY_END)
  if (end < start) throw new Error('Marcadores da política Supremo fora de ordem.')
  return content.slice(0, start) + POLICY + content.slice(end + DEVELOPMENT_POLICY_END.length)
}
