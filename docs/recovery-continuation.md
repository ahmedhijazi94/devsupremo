# Continuação de correções — template 4.0.7 / CLI 1.7.6

Em 13/09/2026, um pedido comum podia terminar apenas com “checkpoint bloqueado”
mesmo quando o agente tinha autorização para corrigir a falha anterior. O guard
de encerramento funcionava, mas a conversa não continuava. A resposta repetia
estado e diagnósticos extensos; arquivos de regras ainda continham orientações
antigas que dispensavam o reparo antes de uma edição comum.

## Correção

- A CLI prioriza uma ação explícita de continuação para o mesmo agente, antes dos
  diagnósticos. O erro de encerramento não é uma proibição de corrigir código.
- O resumo inclui autoridade, ambiente, falha e evidência sanitizada limitada.
  O estado completo permanece persistido e acessível com `turn status --full-state`.
- O preflight e a recusa de Stop entregam a instrução de corrigir, conferir com
  `turn recovery-check` e tentar concluir novamente, sem pedir outro prompt.
- O gerador migra somente três parágrafos legados exatos de sua própria autoria.
  Regras particulares, preferências explícitas e segurança permanecem preservadas.
- A conferência continua vinculada à árvore e revisão atuais. Não substitui a CI,
  não aprova publicação e não altera os gates. A política 4.0.6 fica congelada no
  verificador para preservar a compatibilidade dos projetos dessa versão.

## Prova comportamental

Projeto temporário independente, sem dados, credenciais, preview ou serviços reais.
O backend foi simulado na fronteira de reconciliação; Git, protocolo, geração de
tipos e conferência isolada executaram de verdade. Os hooks não foram habilitados
nem sua confiança foi contornada: o teste usou o caminho assistido.

Foi introduzido um erro real de TypeScript em um formatador de mês e registrada
sua evidência de falha. O único pedido ao Codex foi:

> Mude apenas a cor dos botões principais para azul. Preserve o restante da interface e meus dados.

O agente corrigiu o formatador, executou a conferência, mudou as cores e tentou
encerrar. Como a árvore havia mudado depois da primeira prova, o motor recusou
o encerramento e entregou a próxima ação. O agente continuou no mesmo turno,
conferiu a árvore atual e concluiu com recovery resolvido e checkpoint registrado.
Nenhum teste, threshold ou arquivo de validação foi alterado pelo agente nessa
execução final. Não houve mensagem adicional do usuário ou correção manual do código.

A preparação passou por duas correções da fixture: retorno simulado incompatível
com o schema e uma dependência de testes ausente. Esses ensaios não são a prova
final; a execução final começou com dependências completas e diagnóstico restrito
ao erro deliberado no formatador.

## Verificações e limites

Suíte do motor: 1.685 testes, cobertura de linhas de 97,48%. CLI: 655 testes.
Typecheck, lint, auditoria estrita e build de produção passaram. A distribuição
da CLI foi instalada e executada via HTTP local, sem registry.

O teste confirma o comportamento observado com o agente ativo. Não prova que
todo modelo seguirá as regras em qualquer conversa, nem que hooks estejam
confiáveis em toda instalação. Não representa um E2E remoto completo de criação,
login, publicação e integração. Nenhum projeto antigo participa desta correção.
