# Plano de evolução do motor Supremo

Plano proposto em 5 de outubro de 2026. Implementação da release 1.14.0 concluída em código e em validação de distribuição. O estado de entrega, as provas realizadas e os limites restantes estão em [Entrega do motor 1.14.0](./entrega-motor-1.14.0.md). Os critérios abaixo continuam sendo a referência; uma implementação não equivale a uma prova de todos os provedores e hosts.

O objetivo é permitir que o usuário descreva uma funcionalidade e o agente conduza preparação, código, configuração, execução e verificação pelo Supremo. O resultado deve se aproximar da experiência do Lovable nos cinco pontos acordados: agilidade, recuperação autônoma, integrações completas, painel operacional e atualização dos projetos existentes.

Deploy dos aplicativos na Vercel, domínio, DNS e uma nova plataforma de hospedagem ficam fora do escopo, conforme solicitado. A publicação do próprio motor e de sua CLI será necessária para distribuir as melhorias quando implementadas. Publicação de Edge Functions continua no escopo, pois faz parte das integrações e rotinas do backend.

Este documento define entregas e provas de funcionamento. Não promete ausência absoluta de defeitos, acesso a operações que um fornecedor não disponibiliza ou um prazo universal para o agente escrever qualquer funcionalidade.

**Experiência que deverá ser entregue**

1. O usuário pede uma mudança. O agente recebe as capacidades reais, a versão ativa e as pendências relevantes daquele projeto.
2. O preview aparece assim que o código necessário estiver disponível, preservando processo, porta, sessão e dados.
3. Operações já autorizadas são executadas sem repetir perguntas. Quando faltar uma credencial, o Supremo apresenta um formulário seguro; o valor não atravessa o chat.
4. O motor acompanha cada etapa e continua o trabalho autorizado por um executor disponível. Uma interrupção não perde a tarefa nem repete efeitos já realizados.
5. A interface distingue mudança disponível, validação pendente e funcionamento comprovado. Nenhuma dessas condições é deduzida apenas de um comando terminar sem erro.
6. Se houver uma limitação real, o agente apresenta a causa, o que já foi feito e o próximo passo executável. Não existe “aguardando revisão” sem uma revisão disponível.

O Supremo controla seu servidor, painel, CLI e integração com o agente. Um campo dentro do chat nativo e a confiança nos hooks dependem das capacidades do aplicativo hospedeiro. Nos hosts compatíveis, o agente abrirá o formulário seguro do Supremo automaticamente. Se o host não permitir abrir o navegador, apresentará o link e preservará o pedido para retomada. Uma apresentação dentro do chat será usada apenas quando o host oferecer suporte documentado.

**Base atual que será aproveitada**

A auditoria considerou a CLI 1.13.0 e o código local 2f0d99b. Já existem cofre criptografado, entrega de secrets por API, deploy de funções, jobs, administração parcial de Auth, migrations, exclusão planejada, checkpoints e workers locais.

As lacunas confirmadas são a recuperação síncrona após certas falhas, contratos administrativos incompletos, atualizações fragmentadas e um painel predominantemente de consulta. O trabalho amplia os serviços existentes; não recria o produto ou muda o framework dos aplicativos.

As referências externas descrevem o produto atual e não fornecem garantia de paridade. O Lovable reúne operações de banco, usuários, arquivos, funções, jobs e uso em seu Cloud; o Supremo deve oferecer percursos equivalentes nas áreas incluídas neste plano. [Lovable Cloud](https://docs.lovable.dev/features/cloud).

**Decisões de arquitetura**

| Decisão | Aplicação no motor |
| --- | --- |
| Um serviço para agente e painel | CLI, APIs e Server Actions usam os mesmos contratos, autorização e verificação. O painel não ganha uma rota privilegiada alternativa. |
| Capacidades verificáveis | Cada operação declara executor, ambientes, versão mínima, entradas, efeitos, limites, testes e forma de conferir o resultado. Capacidade sem executor não aparece como pronta. |
| Execução persistente | Toda mutação relevante recebe ID, chave de idempotência, proprietário, projeto, ambiente, revisão da autorização, tentativas e recibo. |
| Autoridade no servidor | Conta, projeto, destino e permissões são resolvidos e conferidos pelo servidor antes dos efeitos. |
| Continuidade com limites | Repetições, reparos por modelo e chamadas externas têm orçamento, prazo e responsável. Esgotamento produz um impedimento concreto. |
| Prova vinculada ao código | Resultados identificam snapshot, dependências, configuração e versão do verificador. Uma aprovação antiga não aprova automaticamente uma alteração nova. |
| Migração gradual | Novas funções entram desativáveis por projeto, preservando leitura do histórico e conclusão das operações já iniciadas. |
| Segurança preservada | RLS, isolamento, verificação de dono, controles de credenciais e testes obrigatórios permanecem exigidos. |

O catálogo de capacidades será a fonte das instruções geradas, da ajuda da CLI e do painel. Os documentos históricos ficam identificados como históricos. Isso evita que o agente siga uma regra antiga ou prometa uma operação ainda ausente.

**Estado das operações e dados persistidos**

Separar três dimensões. O pedido pode ter preview disponível enquanto sua validação continua pendente; uma função pode estar publicada enquanto o envio de email ainda não foi comprovado.

| Dimensão | Estados propostos |
| --- | --- |
| Pedido | Em execução, preview disponível, aguardando dependência, concluído, interrompido, cancelado |
| Operação administrativa | Planejada, autorizada, aguardando autorização, na fila, executando, verificando, concluída, falhou, resultado incerto, expirada, cancelada |
| Verificação | Pendente, executando, aprovada, reprovada, substituída, indisponível |

Cada estado de espera precisa informar responsável, motivo, próximo passo e prazo de nova avaliação. Uma operação não suportada encerra com essa informação; não entra numa fila fictícia. A conclusão de um pedido exige comprovar seus próprios critérios. Uma falha antiga comprovadamente independente pode continuar em operação separada, visível na saúde do projeto; isso não autoriza integrar uma versão que ainda falha nos gates exigidos. Entrega disponível e validação em andamento permanecem estados distintos.

Evoluir os registros existentes e adicionar, quando necessário, entidades para políticas de automação, operações, etapas, recibos e aprovações. Todas as tabelas novas terão RLS, created_at, updated_at, índices nas relações e ações de exclusão explícitas. Credenciais continuam na estrutura criptografada existente, fora de planos, logs, filas e relatórios.

Usar journal local com escrita atômica para a execução no computador e persistência no servidor para efeitos administrativos. IDs de correlação ligam pedido, operação, snapshot e fornecedor. O journal é histórico de execução, não um novo local para armazenar prompts completos ou dados pessoais desnecessários.

**Etapa 0 — Catálogo real e medição do comportamento**

Objetivo: estabelecer uma base verificável antes de alterar a forma de execução.

Entregas:

- Inventariar capacidades atuais, identificar entradas duplicadas e distinguir implementação real de funcionalidade planejada.
- Reproduzir os casos relatados em projetos de teste: pedido visual após falha, comando expirado, daemon antigo, credencial salva sem integração concluída e revisão sem executor.
- Registrar durações de preparação, captura, fila, testes, rede, inferência, aplicação e verificação.
- Separar métricas de desempenho do motor do tempo de geração de código e da espera do usuário.
- Revisar as ações legadas de banco sem consumidores. Retirar entradas obsoletas apenas depois de confirmar ausência de uso.
- Preparar identificação de versão e flags de ativação por projeto.

Aceite: cada cenário reproduzido gera evidência com causa, duração, estado e responsável. Nenhuma operação não implementada é apresentada como disponível.

Áreas: packages/cli/src/turn-runtime.ts, daemon.ts, src/lib/checkpoint, src/lib/capabilities e documentos gerados dos templates.

**Etapa 1 — Autorização persistente e executor comum**

Objetivo: permitir autonomia real para o que o dono autorizou, sem o agente precisar inventar atalhos.

Entregas:

- Criar o serviço comum de operações administrativas, reaproveitando os validadores de dono, dispositivo, ambiente, leases e auditoria existentes.
- Padronizar o percurso preparar → autorizar → executar → verificar → registrar recibo.
- Permitir ao dono configurar uma política por projeto e ambiente: capacidades, recursos, limites, dispositivos, destinatários de teste e orçamento de efeitos externos.
- Oferecer um perfil de desenvolvimento assistido pelo agente, com leitura, edição de código e operações de backend delimitadas. A política pode ser autorizada uma vez e reutilizada.
- Tornar a política versionada, revogável e consultável pelo agente. O agente não pode ampliá-la nem aprovar sua própria exceção.
- Quando faltar autorização, preparar o plano concreto antes de pedir a extensão mínima necessária. Aprovação pontual fica vinculada ao plano, destino, prazo e revisão.
- Distinguir autorização técnica da declaração textual “o usuário pediu”. Esse texto pode registrar contexto, mas não substitui a política autenticada do dono.
- Revalidar mudanças de conta, projeto, ambiente e revogação antes de novos efeitos. Ambiente desconhecido não é tratado como desenvolvimento.
- Usar limites compartilhados entre instâncias para operações privilegiadas. Substituir dependência exclusiva do contador em memória onde ela comprometer esse controle.

Operações dentro da política seguem sem perguntas repetidas. Conectar contas, fornecer credenciais novas ou ampliar autoridade só pede a interação indispensável. Restrições do host continuam válidas; um bloqueio do host não pode ser contornado por outro executor.

Aceite: política do projeto A não autoriza B; dispositivo não amplia política; revogação bloqueia efeitos ainda não iniciados; autorização válida persiste após retry e reinício; toda aprovação solicitada possui execução e retomada implementadas.

Dependência: etapa 0. Áreas: src/lib/checkpoint, src/lib/projects, novos serviços em src/lib/backend-operations, endpoints, Server Actions e migrations do motor.

**Etapa 2 — Resposta rápida e validação sem repetição**

Objetivo: eliminar a espera desnecessária do caminho de desenvolvimento mantendo provas antes da integração final.

Entregas:

- Classificar se uma falha antiga impede realmente o pedido atual. Corrigir dependências necessárias; permitir trabalho independente enquanto a recuperação continua.
- Aplicar o reparo e a mudança pedida antes da conferência final, evitando validar uma árvore que será imediatamente alterada.
- Unificar pedidos de verificação do agente e do worker para não executar a mesma suíte duas vezes no mesmo snapshot.
- Executar checks direcionados quando houver evidência confiável dos arquivos ou casos envolvidos. Falhas globais de cobertura continuam exigindo a prova correspondente.
- Reutilizar evidência no snapshot exato, incluindo dependências, configuração e verificador. Reuso entre snapshots só poderá existir para checks com análise de impacto e dependências comprovada por testes; na dúvida, executar novamente. Resultado parcial nunca vale como aprovação da suíte completa ou da versão nova.
- Manter uma execução pesada por projeto, com prioridade para o snapshot atual. Cancelar trabalho obsoleto com estado “substituído”, preservando diagnósticos ainda relevantes.
- Devolver um ID de acompanhamento para comandos longos. A espera interativa tem limite; o trabalho continua registrado e consultável.
- Manter preview, sessão e edição disponíveis sempre que o impedimento não afetar essa operação.
- Preservar testes e checks obrigatórios antes de commits reais e integração. Checkpoint de trabalho e disponibilidade de preview não serão apresentados como commit aprovado.

Metas iniciais de engenharia, a calibrar após a medição da etapa 0: sobrecarga do caminho saudável aquecido com p95 de até 3 segundos; captura de projeto pequeno ou médio com p95 de até 1 segundo; falha de conexão com resposta útil em até 5 segundos; comando que continuar longo entrega acompanhamento em até 5 segundos. Essas metas não incluem tempo do modelo, compilação, testes, instalação ou fornecedor e não representam desempenho já atingido.

Aceite: pedido visual após falha de tipos produz apenas a conferência necessária sobre a versão final; teste global não vira aprovado por execução parcial; uma alteração posterior invalida a prova aplicável; nenhuma validação bloqueia a conversa apenas para aguardar CI.

Dependência: estados e correlação da etapa 0. Deduplicação e conferência final podem ser entregues antes. A liberação de pedidos enquanto há reparo obrigatório em andamento só será ativada quando a etapa 3 oferecer fila durável e executor responsável comprovadamente disponíveis; sem isso, não prometer continuação automática.

**Etapa 3 — Recuperação durável e continuidade**

Objetivo: substituir “pendente para sempre” por continuação executável ou impedimento explícito.

Entregas:

- Trocar filas que dependem da duração de um comando por registros persistentes com resultado consultável por ID.
- Um timeout da CLI não apaga a intenção nem transforma um efeito possivelmente realizado em falha segura para repetir.
- Implementar posse temporária das tarefas com heartbeat, identidade do processo e token de execução. Um executor antigo perde o direito de escrever depois de ser substituído.
- Detectar encerramento sem Stop, processo morto, suspensão e retomada. Não liberar uma tarefa só porque um relógio venceu enquanto seu executor ainda pode estar ativo.
- Implementar serviço de usuário supervisionado nos sistemas declarados suportados, sem privilégios de administrador; a primeira prova será no macOS com launchd. O bootstrap registra esse modo dentro da autorização concedida e respeita pausa, desativação e desinstalação. Nos ambientes sem suporte, declarar retomada somente ao abrir o host/projeto, sem anunciar reinício automático após reboot.
- Registrar antes dos efeitos, reconciliar depois de respostas perdidas e nunca repetir automaticamente uma mutação de resultado desconhecido sem conferir o fornecedor.
- Repetir falhas transitórias reconhecidas com limite, espera crescente e respeito a Retry-After.
- Separar falha de código, infraestrutura, credencial, fornecedor, segurança e dado incompatível. Cada classe tem uma ação concreta.
- Executar reparos de código em cópia isolada, com orçamento e autorização persistidos. Aplicar somente se a árvore do usuário continuar compatível.
- Continuar correções ordinárias por runner autorizado quando disponível. Não permitir que um reparador reduza cobertura, remova testes ou desative RLS para obter aprovação.
- Para alterações fora do escopo do reparador, registrar uma operação com a capacidade adequada; não ampliar silenciosamente seus poderes.
- Produzir atualização útil no painel após uma mudança de estado. Evitar notificações e consultas repetitivas quando nada mudou.

O executor local depende de o computador estar acordado e disponível. Nos sistemas com serviço supervisionado ativo, a retomada será automática quando ele voltar; nos demais, ocorrerá ao abrir o host/projeto, com essa condição visível. Jobs já instalados no Supabase continuam no provedor. Execução ininterrupta de agentes com o computador desligado exigiria um executor remoto e não será prometida neste plano.

Aceite: interromper host, daemon, rede e processo entre escrita e confirmação, incluindo reinicialização do sistema; retomar sem perder código. Efeitos externos usam idempotência ou reconciliação comprovada; quando ambas forem impossíveis, preservar resultado incerto e impedir nova mutação automática. Toda espera tem causa e responsável. Nenhum “executando” permanece sem heartbeat válido e sem reconciliação.

Dependências: etapas 0 e 1; integra-se à etapa 2. Áreas: database-queue.ts, daemon.ts, engine-repair.ts, turn-runtime.ts, feedback e persistência de operações.

**Etapa 4 — Atualização confiável dos projetos existentes**

Objetivo: um pedido de atualização chegar à versão efetivamente em execução, sem reconstruir o app.

Entregas:

- Criar manifesto de compatibilidade do servidor, CLI incluída, CLI resolvida, hooks, verificador, template, formato das filas e daemon ativo.
- Permitir ao agente preparar e aplicar uma atualização já autorizada pelo serviço comum. Reutilizar o fluxo de revisão quando necessário, sem exigir abrir GitHub para ações cobertas pela política.
- Comparar arquivos gerenciados com sua base conhecida e tratar personalizações por combinação controlada. Nunca sobrescrever configuração divergente como se estivesse intocada.
- Validar o candidato em cópia isolada antes de aplicar.
- Antes de aplicar, reconferir os arquivos reais sob lock contra a base do candidato. Aplicar arquivos com journal e cópia recuperável; resolver a dependência local correta. Se houver edição concorrente, preservar os dois estados e refazer a combinação.
- Drenar ou pausar workers de modo recuperável, substituir apenas o daemon identificado e confirmar a nova versão por heartbeat.
- Preservar preview, porta, sessão, variáveis e mudanças não relacionadas. Atualizações de supervisor podem aguardar a próxima inicialização segura do preview.
- Migrar filas com compatibilidade explícita. Uma versão antiga não recebe um formato que não entende.
- Reverter apenas ferramentas e arquivos gerenciados se a atualização falhar, reconferindo que não houve edição posterior. Preservar alterações concorrentes em vez de sobrescrevê-las. Bloquear downgrade incompatível com uma fila já migrada, mantendo um executor compatível para recuperação. Nunca reverter automaticamente migrations do aplicativo.
- Mostrar separadamente versão disponível, arquivos atualizados e versão ativa confirmada.

Aceite: atualizar um projeto antigo com personalizações, preview aberto, fila pendente e daemon anterior; interromper no meio e retomar; editar entre validação, aplicação e rollback; comprovar que o app e o histórico permanecem e a nova CLI local está ativa. Atualizar a CLI global sozinha não passa nesse teste.

Dependências: etapas 0 e 3. Áreas: template-sync, template-update-card, host-adapters, prepare, daemon e templates.

**Etapa 5 — Banco e autenticação administráveis pelo agente**

Objetivo: resolver pedidos comuns de dados, estrutura e contas sem “arquivo para revisão” sem destino.

Entregas de banco:

- Evoluir o plano de exclusão para INSERT, UPDATE, UPSERT e DELETE tipados, com seleção, chaves resolvidas pelo servidor, impacto, dependências e confirmação.
- Começar com operações pequenas por chave; ampliar para filtros e lotes com limites por política. Não permitir dividir pedidos artificialmente para escapar dos limites.
- Aceitar colunas enum, arrays e campos calculados quando a operação apenas preserva esses campos e o efeito for verificável. Recusar pela ação real, não pela presença de uma coluna não envolvida.
- Analisar SQL estruturalmente, com catálogo e defesa independente de transação somente leitura nas consultas. Literais e comentários com palavras SQL não devem causar falsos bloqueios.
- Resolver views, funções e relações para impedir efeitos indiretos. Credenciais, vault e acesso irrestrito a catálogos sensíveis ficam fora do editor livre.
- Executar escritas do editor pelo mesmo planejamento administrativo; não abrir um túnel genérico de SQL privilegiado. Alterações estruturais iniciadas no painel também geram migration versionada em /supabase/migrations/ e reconciliam o arquivo, tipos gerados e histórico do projeto. Sem executor disponível para registrar esses artefatos, manter a operação preparada; não aplicar DDL silenciosamente fora do histórico.
- Planejar mudanças de constraints, índices, policies e funções invoker com verificação do catálogo e ensaio em banco descartável.
- Para transformações arriscadas, usar expansão de schema, preenchimento dos dados e troca dos consumidores antes de remover estruturas antigas.
- Manter SQL dinâmico e privilégio irrestrito fora do canal. Funcionalidades que exigem autoridade especial usam serviços administrativos específicos e revisados.
- Não apresentar uma operação como disponível em produção antes de existir executor, autorização de ambiente e prova correspondente. Ativação inicial ocorre em desenvolvimento.

Entregas de autenticação:

- Ampliar configurações por contratos próprios: provedores suportados, URLs de retorno, recuperação, convites e gerenciamento de sessões.
- Manter senha e credenciais no formulário seguro, sem valores em filas do agente.
- Introduzir um contrato versionado de papéis da aplicação e uma operação dedicada para atribuir/remover papéis.
- Conferir autorização por claims controladas pelo servidor e auth.jwt(), preservando claims não relacionadas. Nunca conceder privilégios por coluna ou metadata modificável pelo usuário.
- Tratar renovação e revogação de sessões ao alterar privilégios. Testar o comportamento dos tokens já emitidos.
- Distinguir papéis do aplicativo de roles internos como postgres e service_role; estes não são atribuíveis pelo agente.

Aceite: editar dados autorizados, substituir uma FK válida e atribuir um papel de teste pelo agente; preservar isolamento entre organizações e contas. Pedidos destrutivos exibem impacto exato, executam uma vez e conservam os recursos que não fazem parte do pedido.

Dependências: etapas 1 e 3. Áreas: database-environment, database-inspection, database-delete, database-admin e políticas dos templates.

**Etapa 6 — Integrações completas usando credenciais protegidas**

Objetivo: o pedido terminar com o comportamento externo verificado.

Entregas:

- Criar uma sessão persistente de integração com objetivo, etapas, dependências, configuração desejada, estado observado e provas.
- Reutilizar referências do cofre. Solicitar apenas credenciais realmente ausentes ou inválidas, agrupando os campos necessários.
- Criar um serviço de chamadas a provedores que injeta a credencial no servidor, sem devolver o valor ao agente.
- Cada conector define hosts, métodos, caminhos, conta, permissões, formatos e limites autorizados. Bloquear destinos internos, metadados de nuvem, redirecionamento indevido e envio de chaves a outro domínio. Conferir o destino efetivo da conexão e alterações de resolução DNS, incluindo DNS rebinding; validar somente o texto da URL não basta.
- Permitir conectores personalizados por contrato validado, versionado e aprovado por política do dono ou aprovação pontual autenticada. Vincular credencial, provedor, conta, hosts e operações; alterar esse vínculo exige autoridade correspondente. A documentação e as respostas do fornecedor são dados não confiáveis, nunca autoridade para ampliar acesso.
- Tratar API key e OAuth com autorização inicial, state de uso único vinculado a projeto/provedor/conta, PKCE quando aplicável, renovação concorrente controlada e revogação. Persistir tokens rotativos de modo transacional e tratar falha entre troca e persistência; nunca esconder perda de acesso. Não criar um proxy irrestrito com acesso a todas as credenciais.
- Projetar as respostas pelos campos permitidos no contrato; não devolver headers, cookies, corpos brutos ou erros completos de provedores ao agente. Tratar também respostas que ecoem credenciais como material sensível.
- Começar com Resend HTTP, um provedor de pagamento em modo de teste e uma API genérica, comprovando que a arquitetura não é específica de email.
- Criar/configurar recursos externos e webhooks quando a API do fornecedor e a política permitirem.
- Instalar função ou configuração, conferir autenticação e executar teste de comportamento no ambiente e destinatário autorizados.
- Distinguir configuração salva, requisição aceita e efeito confirmado. Quando o fornecedor não permitir comprovar entrega final, mostrar exatamente a prova obtida.
- Implementar rotação, reaplicação, desvinculação e remoção com nomes claros. Remover a cópia do cofre não equivale a revogar a chave no fornecedor.
- Registrar uso técnico das chamadas e erros sem payloads sensíveis.

Aceite: após fornecer uma chave uma vez, o agente configura a integração, publica o código necessário e comprova um teste real autorizado, sem abrir o painel do fornecedor. Após perda de conexão, usa idempotência ou reconciliação disponível para evitar duplicação e reaproveita a chave válida. Sem meio de determinar o efeito, mantém resultado incerto e impede nova mutação automática. OAuth precisa passar por testes de callback repetido ou trocado, conta divergente, refresh concorrente e falha de persistência do token rotativo.

Limites: API inexistente, permissão insuficiente, verificação de domínio, verificação de identidade e consentimentos externos continuam sendo dependências reais. O motor deve identificá-las antes e automatizar o restante. Configuração de DNS permanece fora do escopo.

A referência do Lovable inclui conectores gerenciados e integração direta, com credenciais fora do chat; também depende de a API disponibilizar a operação necessária. [Integrações de API do Lovable](https://docs.lovable.dev/integrations/any-api).

Dependências: etapas 1 e 3; usa capacidades da etapa 5 e ciclo de funções da etapa 7. Áreas: credentials, secret-requests, edge-functions, integration-request e novos conectores de provedor.

**Etapa 7 — Funções e rotinas com ciclo completo**

Objetivo: permitir ao agente administrar funções e tarefas diárias, incluindo sua manutenção posterior.

Entregas de funções:

- Completar consulta de versão, publicação, teste, logs, substituição de hooks, desativação, exclusão e retorno a artefato anterior conhecido.
- Versionar código, configuração e referências de secrets; segredos não entram no artefato.
- Conferir dependências antes de remover ou substituir função utilizada por jobs ou hooks.
- Separar prova de publicação, autenticação e comportamento.
- Preservar assinatura de webhooks, limites de execução e proteção contra repetição.

Entregas de jobs:

- Manter Supabase como destino padrão para tarefas do aplicativo ligadas ao banco ou a Edge Functions. GitHub Actions fica para automações do repositório, não como alternativa automática para executar trabalho de negócio.
- Interpretar o horário no fuso do projeto e mostrar a próxima execução. Horário de verão precisa de comportamento explícito.
- Permitir criar, alterar, executar um teste imediato, pausar, retomar e remover.
- Usar operações de dados estruturadas para trabalhos simples e função autenticada para lógica complexa.
- Definir concorrência, timeout, política de repetição e identificação durável de cada execução.
- Proteger contra efeitos duplicados. Onde o provedor não oferece idempotência, reconciliar o efeito antes de tentar novamente e declarar os casos incertos.
- Registrar início, término, resultado e falha de cada execução; disponibilizar alertas no Supremo conforme preferência do dono.
- Diferenciar rotina agendada de rotina que executou corretamente.

Aceite: “todo dia às 9h no horário do projeto” produz agendamento e teste imediato verificados. Repetição de entrega não repete o efeito. Trocar a função mantém o job íntegro; excluir exige tratar a dependência.

O Lovable expõe tarefas agendadas e histórico de execução no próprio produto; o objetivo é oferecer um percurso equivalente com o backend já usado pelo Supremo. [Jobs do Lovable](https://docs.lovable.dev/features/jobs).

Dependências: etapas 1 e 3; operações de dados da etapa 5 quando aplicáveis. Áreas: edge-functions, database-jobs, functions-command e jobs-scaffold.

**Etapa 8 — Painel operacional completo**

Objetivo: administrar as áreas acordadas pelo Supremo, usando os mesmos serviços disponíveis ao agente.

| Área | Entrega |
| --- | --- |
| Tabelas | Estrutura, filtros, paginação, edição, inserção, exclusão planejada e importação/exportação com limites e prévia de impacto. |
| SQL | Consultas, resultados, histórico sanitizado e escritas planejadas pelo executor comum. Sem uma segunda rota administrativa irrestrita. |
| Usuários | Listagem, ações suportadas de conta, papéis, sessões e configuração dos provedores implementados. |
| Arquivos | Buckets privados por padrão, configuração, listagem de objetos, upload, download autorizado, URLs temporárias e exclusão planejada. Políticas por usuário/organização continuam exigidas. |
| Funções | Código/versão quando disponível, status, logs, teste e operações de manutenção implementadas na etapa 7. |
| Jobs | Horário e fuso, próxima execução, histórico, teste imediato, pausa, retomada e remoção. |
| Integrações | Estado real, campos pendentes, referência ao cofre, rotação e último teste comprovado. Nunca exibir o segredo salvo. |
| Logs | Busca e filtros compatíveis com a fonte, causa sanitizada e ligação com a operação ou função. Retenção e limites ficam explícitos. |
| Uso | Métricas disponíveis, séries coletadas, cotas obtidas do fornecedor e alertas por limite configurado. Dados indisponíveis aparecem como indisponíveis, não como zero. |

Para Storage, implementar API de objetos e policies apropriadas; não escrever diretamente nas tabelas internas do Supabase como atalho. Upload/download deve ter limites de tamanho, tipo, destino e autorização.

Custos de terceiros só serão exibidos quando houver fonte confiável. Estimativas, se oferecidas, precisam indicar a tarifa usada e permanecer separadas de cobrança real.

Aceite: realizar pelo painel e pelo agente a mesma operação com a mesma política, resultado e auditoria; testar duas contas distintas; verificar estados de carregamento, erro, permissão e conclusão em celular e desktop.

Dependências: etapas 1, 5, 6 e 7 por área. Entregar o painel por abas à medida que seus serviços estiverem prontos, sem esperar uma reescrita completa. Áreas: project-backend, backend-panels e Server Actions.

**Sequência de implementação e paralelismo**

1. Concluir etapa 0 e registrar a linha de base.
2. Implementar o núcleo da etapa 1 e o caminho rápido da etapa 2 em mudanças separadas.
3. Fechar persistência e retomada da etapa 3, integrando o caminho rápido.
4. Implementar atualização da etapa 4; banco/Auth da etapa 5 podem avançar em paralelo depois dos contratos comuns.
5. Implementar ciclo de funções/jobs da etapa 7 e conectores da etapa 6 em paralelo, com interfaces combinadas.
6. Entregar as abas da etapa 8 progressivamente.
7. Executar a matriz completa, corrigir lacunas e liberar gradualmente.

Dividir as etapas extensas em mudanças pequenas: contrato e testes; servidor; CLI; painel; integração real. Cada mudança deve poder ser revisada com suas provas. Não acumular tudo num único PR nem deixar uma ampliação de autoridade habilitada antes de existir a validação correspondente.

A etapa 0 fornecerá dados para estimar esforço por bloco. O plano não atribui um prazo fechado a integrações ainda não ensaiadas.

**Provas de aceitação antes da liberação geral**

| Cenário | Resultado exigido |
| --- | --- |
| “Mude esta cor” com uma falha anterior independente | Preview atualizado, pedido não preso à suíte antiga e reparo acompanhado separadamente. |
| Falha anterior que impede a feature pedida | Reparo e feature usam uma conferência final coerente; dependência fica explícita. |
| Resultado de teste antigo chega depois do novo | Não sobrescreve o estado da versão atual nem apaga diagnóstico relevante. |
| Host fecha sem Stop | Operação é reconciliada e retomada quando houver executor; sem atividade fantasma permanente. |
| Timeout depois de escrita externa | Consulta pelo mesmo ID e reconciliação; efeito não é repetido às cegas. |
| Duas sessões editam durante o reparo | Nenhuma proposta sobrescreve alterações novas; candidato fica isolado. |
| Atualização com preview aberto e fila pendente | Versão ativa comprovada, sessão preservada e rollback das ferramentas ensaiado. |
| “Use esta API” | Uma coleta segura de chave, configuração, execução e prova final; nenhuma chave em chat, logs ou bundle. |
| Chave já existente | Reutilização automática no destino autorizado, sem novo formulário. |
| Conexão OAuth interrompida ou repetida | Callback de uso único, conta correta, refresh concorrente e persistência do token rotativo comprovados; revogação não é ocultada. |
| “Envie diariamente às 9h” | Fuso, próxima execução, assinatura, histórico, teste e deduplicação comprovados. |
| “Exclua a empresa de teste” | Impacto delimitado, preservação da conta e papel não incluídos, autorização válida e exclusão única. |
| “Torne esta conta Master” | Identidade exata, papel da aplicação autorizado, claims e renovação/revogação verificadas. |
| Atualizar campo em tabela com enum não envolvido | Operação legítima permitida; tipo presente na tabela não provoca bloqueio indiscriminado. |
| SQL com palavra DROP dentro de texto | Texto tratado como literal, com controles reais de SQL mantidos. |
| Usuário de A tenta dados, plano ou segredo de B | Negado no servidor e no banco, sem vazamento de valores. |
| Permissão revogada durante a execução | Novos efeitos bloqueados; recibo informa o que já aconteceu. |
| Host externo malicioso ou redirecionamento | Chave não é enviada; endpoints privados e destinos não autorizados são bloqueados. |
| Fornecedor responde 429, 500 ou resultado ambíguo | Retentativa limitada quando segura; ambiguidade preservada até reconciliação. |
| Bucket privado de documentos | Upload e download autorizados; outro usuário/organização não obtém arquivo nem URL utilizável. |
| Remover função ligada a job | Dependência tratada no plano; nenhum job fica silenciosamente quebrado. |
| Capacidade ausente | Resposta concreta de indisponibilidade, sem aprovação inútil ou promessa de revisão automática. |

Os testes de banco devem rodar em PostgreSQL/Supabase descartável com operações reais, além dos testes unitários. Rotas, policies e autenticação precisam de provas de isolamento entre donos e organizações. Provedores externos usam ambientes de teste e destinatários expressamente autorizados.

Ensaiar os fluxos em projeto novo e projeto antigo, nas stacks atualmente suportadas e nos adapters de agente declarados suportados. Registrar versão efetiva, recibos de hooks e limitações do host. Não declarar cobertura de um host apenas porque seus arquivos de configuração foram gerados.

**Qualidade e proteção contra regressões**

Antes de cada commit de implementação, cumprir typecheck, lint, cobertura mínima de 85% sobre lógica de decisão, auditoria de segurança estrita e build, conforme AGENTS.md. Acrescentar testes de CLI, E2E, isolamento e contrato de provedor conforme a alteração. Não reduzir thresholds nem substituir provas de integração por mocks para obter aprovação.

Para alterações de Next.js, consultar a documentação da versão instalada antes de modificar APIs do framework. A UI permanece sem lógica de negócio; validação, autorização e mutações ficam no servidor.

Revisar secrets em logs, respostas, checkpoints e artefatos. Verificar autorização e limites também após retries, mudança de vínculo e concorrência. Uma política de autonomia permite executar capacidades delimitadas; não elimina controles de acesso.

**Liberação gradual e reversão**

- Primeiro: testes locais e serviços descartáveis, sem modificar aplicativos em andamento.
- Depois: ambiente de homologação do motor com dois donos e projetos sintéticos.
- Em seguida: projeto piloto existente autorizado, com estado salvo e preview ativo.
- Por fim: ativação gradual por projeto após cumprir os critérios de cada capacidade.

Evoluir o banco do motor com migrations aditivas e compatibilidade com clientes anteriores durante a transição. Publicar servidor compatível, distribuir CLI/templates, confirmar a versão ativa e só então ativar novas capacidades. Alterações de schema dos aplicativos ocorrem apenas quando uma funcionalidade solicitada realmente as exigir.

As flags desativam novas operações sem apagar histórico ou abandonar efeitos iniciados. Rollback de ferramentas não desfaz dados de terceiros nem banco automaticamente. Operações irreversíveis precisam de impacto e recuperação definidos antes da execução.

O encerramento de cada etapa deve informar: código entregue, testes executados, ambiente publicado, versão ativa no piloto e limitações restantes. Código escrito ou CI verde sozinho não significa experiência liberada.

**Definição de pronto para o objetivo**

O motor estará pronto para o escopo acordado quando os cenários desta matriz passarem em projeto novo e atualizado; as cinco frentes estiverem disponíveis pelo agente; o painel compartilhar os mesmos controles; os resultados forem verificáveis; e o usuário só precisar intervir em credenciais, consentimentos externos ou permissões realmente novas.

A meta não exige abandonar o agente escolhido pelo usuário nem criar um chat próprio. Exige que o Supremo ofereça operações completas, estados claros e continuidade confiável para esse agente.

**Referências da auditoria e da implementação**

- [Recuperação síncrona atual](/Users/ahmedhijazi/dev/supremo_claude/packages/cli/src/foreground-validation.ts)
- [Política do worker e reparo](/Users/ahmedhijazi/dev/supremo_claude/packages/cli/src/engine-policy.ts)
- [Fila local de operações](/Users/ahmedhijazi/dev/supremo_claude/packages/cli/src/database-queue.ts)
- [Adapters dos agentes](/Users/ahmedhijazi/dev/supremo_claude/packages/cli/src/host-adapters.ts)
- [Operações de banco](/Users/ahmedhijazi/dev/supremo_claude/src/app/api/database/route.ts)
- [Política de migrations](/Users/ahmedhijazi/dev/supremo_claude/src/lib/database-environment/policy.ts)
- [Planos de exclusão](/Users/ahmedhijazi/dev/supremo_claude/src/lib/database-delete/service.ts)
- [Configuração administrativa de Auth](/Users/ahmedhijazi/dev/supremo_claude/src/lib/database-admin/options.ts)
- [Cofre de credenciais](/Users/ahmedhijazi/dev/supremo_claude/src/lib/credentials/service.ts)
- [Entrega de segredos](/Users/ahmedhijazi/dev/supremo_claude/src/lib/secret-requests/provider.ts)
- [Console de backend](/Users/ahmedhijazi/dev/supremo_claude/src/lib/project-backend/service.ts)
- [Atualização da base do projeto](/Users/ahmedhijazi/dev/supremo_claude/src/actions/template-sync.ts)
