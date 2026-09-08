# E2E v4-2 — recuperação do motor

Data: 08/09/2026. Projeto de referência: `Hijaziia/v4-2` (gestor de despesas).
Entrega do motor: scaffold 4.0.3, CLI 1.7.3.

## Resultado observado no app real

- Preview externo: login existente, criação de uma despesa de teste, edição de valor/status, persistência após recarregar, busca com filtros combinados e exclusão confirmada funcionaram no Chrome.
- O registro criado para esta verificação foi excluído. A despesa preexistente e a sessão do usuário foram preservadas.
- “Limpar filtros” limpou a consulta, mas deixou os seletores mostrando valores anteriores. A correção do formulário e da mensagem de data está preparada; ainda não foi aplicada ao app.
- O preview permaneceu no mesmo processo e porta durante a investigação. Uma resposta negativa do preflight não foi tratada como evidência de servidor desligado.
- A navegação pela ferramenta de navegador integrado retornou `ERR_BLOCKED_BY_CLIENT`; a captura do usuário mostrava `ERR_HTTP_RESPONSE_CODE_FAILURE`. São observações diferentes. Não foi comprovada uma causa única nem a recuperação dentro do Codex.

## Falhas corrigidas no motor

| Falha | Correção | Limite da conclusão |
| --- | --- | --- |
| Auto-heal consumia tentativas ao não encontrar `codex` no PATH do daemon | Resolve o executável instalado, verifica disponibilidade antes de consumir orçamento e preserva tentativas anteriores | Executor indisponível continua sendo diagnóstico; não dispara inferência ilimitada |
| GitHub aprovava sete jobs, mas a integração ficava bloqueada pela leitura do Code Security | Reconhece o caso moderno de repositório privado com recurso explicitamente desativado e a recusa oficial exata | Não equivale a CodeQL aprovado; falha, pendência e configuração desconhecida continuam bloqueando |
| Um bloqueio de integração com recibo de CI aprovado podia causar HTTP 503 no contexto de desenvolvimento | Devolve a falha conhecida, vinculada ao mesmo projeto/checkpoint/SHAs, mantendo a autorização e os gates de publicação | Reproduzido em teste de rota. O serviço remoto respondeu 503; não houve acesso ao log interno para provar causalidade exclusiva |
| Histórico continuava “Testando” depois da validação | Diferencia espera de integração, bloqueio e integração confirmada | Checkpoint antigo com falha permanece como histórico |
| Cabeçalho “Tudo verde” podia esconder bloqueio independente da integração | Mostra “Testes aprovados” e distingue bloqueio confirmado para a mesma PR/revisão | Resultado dos jobs continua disponível; falha de outra revisão não contamina o estado atual |
| Atualizar o manifesto da CLI poderia rejeitar projetos 4.0.2 existentes | Preserva a política 4.0.2 em arquivo imutável e aceita candidatos inteiros de uma das releases explicitamente autorizadas | Não permite combinar validadores de versões, inventar versão autorizada ou alterar dependências protegidas |
| Cadastro gerado redirecionava mesmo quando precisava confirmar email; callback ignorava falha de troca de código | Exige sessão antes de abrir a área autenticada, orienta confirmação e trata callback inválido/expirado sem expor tokens | Exercitado no código efetivamente gerado; não é evidência de login real em todos os provedores |
| Configuração de HTTPS/cookies de preview remoto era misturada ao desenvolvimento local | HTTP local não recebe HSTS/upgrade obrigatório; browser, servidor e proxy compartilham o modo de cookies, preservando renovação, nonce e anticache | Produção mantém HTTPS. Não comprova que esse era o único problema do navegador integrado |

## Evidência de validação

- O PR 1 de `Hijaziia/v4-2`, revisão `81965e9f032cfe823d2f79f58ec6c6e9cc3f8fc3`, apresentou sete jobs concluídos com sucesso: tipos/lint/auditoria, cobertura, RLS, vulnerabilidades, segredos, build e E2E. Na última consulta desta investigação, permanecia aberto, sem merge.
- Os smokes de CI desse app verificam entrada pública/formulário/redirecionamento e políticas de página. Não substituem o CRUD autenticado exercitado manualmente nesta investigação.
- CLI: suíte completa com 603 testes, typecheck e instalação real da distribuição 1.7.3 por HTTP aprovados.
- Motor: 1.590 testes aprovados em 104 arquivos; cobertura de linhas de 95,63%, ramos de 94,85% e funções de 94,91%. Typecheck e lint aprovados.
- Template: smoke com Chromium real aceitou cinco formulários válidos e rejeitou sete inválidos; testes executam o código de autenticação e o proxy gerados.
- Continuidade em app 4.0.3 descartável com Next, Chromium, Git e novos processos reais: duas alterações, dois checkpoints imutáveis e QA adaptativa aprovados. Processo do preview, rascunho e diagnóstico anterior preservados. Alteração visível em 330 ms, devolução do controle em 386 ms, alteração em conversa nova em 346 ms. Essas medidas cobrem o motor/HMR com fronteiras de backend/modelo controladas, não o tempo de geração de uma IA.
- PostgreSQL 14 descartável: migrations 001–024, isolamento de dono/dispositivo, concorrência de restore, ACK idempotente, metadados de secrets e SQL/RLS de jobs aprovados. Cluster encerrado e removido após o teste.
- Build de produção local aprovado com Webpack. O build padrão com Turbopack foi impedido pelo ambiente ao tentar abrir uma porta durante a avaliação de CSS; precisa de confirmação no CI padrão.
- Auditoria estrita: zero achados CRITICAL/HIGH; 13 avisos MEDIUM permanecem registrados.

## Etapas ainda necessárias no ambiente hospedado

1. Publicar a correção do motor e confirmar que o contexto autenticado de desenvolvimento deixa de responder 503.
2. Retomar pelo fluxo oficial do motor, aplicar o patch pontual de filtros/data e atualizar os arquivos gerados de configuração do preview sem sobrescrever alterações do usuário.
3. Comprovar integração remota e atualização do histórico para a mesma revisão; aprovação dos jobs não comprova merge.
4. Revalidar abertura, login e continuidade no navegador integrado do Codex. Não alterar proteções do navegador para contornar uma recusa de acesso.
5. Completar restore pelo serviço real, entrega/consumo de secret no provedor e agendamento com `pg_cron` real. O PostgreSQL descartável não possuía a extensão; seus testes de jobs simularam apenas a fronteira do agendador.

O E2E não está declarado integralmente concluído. As correções do gerador também não atualizam automaticamente um app existente: essa aplicação precisa seguir o fluxo autenticado do motor. Nenhum gate de segurança foi desativado para avançar o app de referência.

## Retomada após publicar o PR 61

Os oito jobs do PR 61 concluíram com sucesso no GitHub, incluindo build padrão, análise estática, compilação/worker/continuidade do template e o job de PostgreSQL com instalação e execução do `pg_cron` real. Isso resolve as limitações locais de Turbopack e extensão indisponível; a configuração de um job no Supabase do app de referência ainda é uma verificação distinta.

O preflight autenticado ainda respondeu HTTP 503. Foi reproduzido outro defeito na rota: o store repassa `created_at` do PostgreSQL com offset explícito e o contrato da CLI exige ISO em UTC terminado em `Z`. Dois casos de offset válidos reproduziram o 503 antes da correção. A rota agora normaliza timestamps válidos para UTC antes de montar o contexto, mantendo compatibilidade com as CLIs já instaladas. Datas impossíveis, sem fuso ou corrompidas continuam sendo rejeitadas. Não modifica dados persistidos, vínculo aos SHAs ou autorização. A confirmação no projeto remoto depende da publicação dessa correção complementar.

O formulário de secrets foi exercitado no serviço real: a CLI solicitou `SUPREMO_E2E_PROBE_TEMP` para Supabase/development; o painel abriu o campo com nome, finalidade, destino e ambiente corretos. O pedido temporário foi dispensado pela interface ao final. Nenhum valor foi fornecido; isso comprova solicitação/apresentação/dispensa, não entrega ou consumo de uma credencial no provedor.

A leitura oficial `jobs list` confirmou o alvo development `pyhjbuprhoxiyggibxjn` e respondeu que o `pg_cron` ou o registro de jobs ainda não está configurado nesse projeto. Não foi criado agendamento no app; a execução do scheduler real aprovada no CI permanece uma evidência distinta.

Foi identificada também uma lacuna de retomada: o polling do daemon atualizava o recibo da CI sem repetir a decisão de integração; um evento perdido ou bloqueio corrigido podia aguardar o cron diário. A rota de feedback agora retoma essa decisão na janela de atualização já existente. Usa o controller completo, token da instalação autorizada, configuração do projeto e vínculo exato de checkpoint/PR/branch/SHA, incluindo nova checagem antes do merge. Jobs verdes apenas iniciam a avaliação; política, workflow confiável, CodeQL e proteções nativas continuam exigidos. A mudança não adiciona espera ao preflight ou ao turno de edição.

A gravação do estado do projeto compara atomicamente o estado observado antes da reconciliação, para não sobrescrever uma integração concorrente com uma resposta antiga. A leitura da configuração é obrigatória nesse caminho: erro ou projeto ausente adia a tentativa, sem escolher um modo de integração alternativo. Testes do adapter usam o construtor PostgREST real e simulam o merge entre a última leitura e o PATCH.

A validação complementar passou com 1.629 testes em 106 arquivos, cobertura de linhas de 95,67%, ramos de 94,90% e funções de 94,91%. Typecheck, lint e auditoria estrita passaram; os 13 avisos MEDIUM continuam registrados.
