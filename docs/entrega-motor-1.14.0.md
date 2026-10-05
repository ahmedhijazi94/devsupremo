# Entrega do motor 1.14.0

Implementação de 5 de outubro de 2026, referente ao [plano acordado](./plano-evolucao-motor-2026-10-05.md). Este registro distingue código implementado, evidência local e publicação. Não declara equivalência universal com o Lovable.

## Implementação

| Frente | Entrega |
| --- | --- |
| Resposta e continuidade | Fila durável com ID, recibos, posse de execução, recuperação após interrupção e limite de cinco segundos para a espera interativa. Validação e reparo compatível continuam em background; resultado incerto não autoriza repetir efeitos. |
| Autorização | Política por dono/projeto/ambiente, capacidades, recursos, computadores e limites compartilhados. Aprovação pontual vinculada ao conteúdo exato, prazo, destino e revisão, com consulta e retomada executáveis. |
| Atualização | Manifesto oficial com digest, atualização transacional dos arquivos gerenciados, candidato isolado, proteção a edições concorrentes, retomada e confirmação da versão efetiva do daemon. CLI antiga arquivada como base verificável. Personalizações já commitadas também são comparadas com bases oficiais; mudanças de dependências têm janela explícita, instalação isolada e troca recuperável. |
| Dados e SQL | Planejamento e aplicação de INSERT/UPDATE/UPSERT/DELETE por chaves exatas, até 25 registros. Editor SQL com consultas limitadas e migrations materializadas pelo executor local, registradas e reconciliadas pelo hash. |
| Usuários | Administração de contas, convites com destinatário autorizado, configuração de login Google/GitHub via campo seguro, papéis da aplicação em claims do servidor e revogação de sessões de renovação. |
| Integrações | Conexões protegidas e contratos para Resend HTTP, Stripe em modo de teste, GitHub e API personalizada. Destinos permitidos, projeção de resposta, proteção SSRF, OAuth com state de uso único e renovação concorrente controlada. |
| Funções e rotinas | Artefatos de funções, consulta, diagnóstico do hook de email, publicação, remoção e rollback, com dependências de hooks/jobs. Jobs com fuso IANA, próxima execução, manutenção e recibos. |
| Painel | Tabelas, SQL, usuários, arquivos, funções, jobs, integrações, logs, uso e automação pelo mesmo serviço autorizado do agente. IDs de mutação persistem no navegador sem guardar credenciais ou payloads. |

As novas capacidades não são habilitadas indiscriminadamente nos projetos existentes. O dono configura a política uma vez no Supremo; ações dentro dela reutilizam a autorização. Exceções possuem revisão e execução reais. O agente não amplia sua própria autoridade.

O catálogo `/api/backend-operations` informa o protocolo 2 e a CLI mínima 1.14.0. Projetos antigos podem atualizar as ferramentas sem recriar o app. Nenhum aplicativo em andamento foi atualizado como parte desta entrega. Deploy dos aplicativos na Vercel continua fora do escopo.

## Provas realizadas

- Motor: 2.963 testes aprovados; 193 arquivos de teste aprovados. Cobertura de decisões: 99,46% das linhas, 93,44% das ramificações e 91,83% das funções nesta rodada.
- CLI: 1.357 testes aprovados em 73 arquivos, incluindo recibos incertos, gravação concorrente, limites de transporte e identidade do destino. A leitura de respostas de banco é interrompida ao exceder 2 MiB ou o prazo, sem repetir uma mutação cujo resultado seja incerto.
- PostgreSQL descartável: 36 testes reais de políticas, isolamento entre donos, concorrência, consumo único de aprovações, mutações, OAuth, jobs e materialização SQL. São executados também na CI; os testes opt-in não são contados como aprovação quando seu banco não está disponível.
- TypeScript e lint do motor aprovados. O lint local excluiu somente `packages/lut-studio/`, diretório não versionado de outro trabalho; nenhuma regra do repositório foi reduzida. Auditoria estrita sem achados HIGH/CRITICAL; 18 avisos heurísticos MEDIUM, relacionados a adaptadores com autorização no servidor, permanecem visíveis.
- Build de produção aprovado com Webpack. O caminho Turbopack deste ambiente falhou ao abrir uma porta interna; o build alternativo manteve as verificações de produção.
- Atualização de dependências: instalação npm real em fixture privada, CLI instalada executada e ausência de execução do `postinstall` confirmada. Testes de interrupção entre os renames e de rollback conservaram as duas instalações e alterações concorrentes.
- Histórico Git e bundle distribuído verificados com Gitleaks 8.21.2, sem segredos encontrados.
- Console renderizado no Chromium com dados sintéticos em desktop e celular. As dez abas e os estados de erro/permissão foram conferidos; nomes longos permanecem dentro da página em 390 px e 1.440 px. Os 19 testes de componentes também passaram. Esse ensaio não simula uma conta externa autenticada.
- A falha de comunicação do executor de testes foi reproduzida: 65 casos síncronos passavam, mas impediam respostas ao RPC por mais de 60 segundos. Liberar o event loop entre os casos corrigiu a mesma reprodução sem aumentar prazos ou reduzir verificações; os 133 testes reais de política do subconjunto também passaram.
- CodeQL: os alertas de produção foram corrigidos. Três alertas em testes foram revisados individualmente e classificados no GitHub como falsos positivos (#87, #94 e #95): o hash usa um nonce OAuth aleatório de 256 bits, não uma senha; as duas leituras de arquivo são asserções em diretórios privados que simulam substituição concorrente. Nenhuma regra, verificação ou teste foi desativado.
- [Aceitação de atualização e runtime](./engine-runtime-acceptance-2026-10-05.md): projetos sintéticos novo/antigo, processos reais, interrupção durante troca de CLI, retomada pelo mesmo ID e preservação de preview, porta, arquivos e fila. Captura Git aquecida com p95 de 130,05 ms em 60 amostras locais; não inclui modelo, Internet ou testes.

## Distribuição

Servidor e CLI devem ser publicados juntos com as migrations aditivas 028, 029 e 034–041 no banco do próprio motor. As migrations não concedem automaticamente permissões a nenhum aplicativo. A distribuição pelo endpoint do Supremo é conferida por SHA-256; a publicação npm usa o workflow oficial de proveniência.

Banco do motor atualizado: as nove migrations foram aplicadas em uma transação, com histórico igual aos arquivos revisados. As 13 novas tabelas tiveram RLS e ausência de escrita por `anon`/`authenticated` conferidos após a aplicação. Digest do conjunto: `2c82b74cf5aa17b6412ca093f38877a6e62369b098fcd3147e3aa1afe10f978e`.

A migration 041 também foi aplicada e conferida separadamente após ensaio em PostgreSQL descartável. Ela amplia somente os metadados permitidos de configuração Google/GitHub; RLS e restrições de escrita foram preservados. SHA-256 do arquivo: `aa55bd2e55a3ab79efe12d0d36a11dbf7fa85a41bbffcfdc68a5710614ee570a`.

Neste registro inicial, servidor e pacote npm ainda estão em publicação. A mensagem final da entrega informará os resultados remotos confirmados; não considerar código local como versão já disponível online.

## Limites explícitos

- A fila libera a conversa; ela não reduz o tempo de geração do modelo, instalação, compilação ou resposta de terceiros. Não há garantia de que toda funcionalidade fique pronta em dois minutos.
- Computador desligado não executa o agente local. O serviço de usuário macOS está implementado; o ensaio de processo não comprova reboot/login real nem funcionamento de todos os hosts de agente.
- Os conectores foram exercitados com contratos e respostas controladas. Não houve cobrança Stripe, email real nem novo consentimento OAuth em conta externa. Testes de efeitos reais dependem de conta, destinatário e operação autorizados.
- Série de uso é coletada nas consultas, no máximo uma amostra por hora, com retenção de 30 dias. Alertas são calculados na consulta. Não há cobrança real estimada como fato, cota de fornecedor indisponível exibida como zero ou promessa de monitoramento contínuo.
- Atribuição de papéis da aplicação e mutações planejadas de dados começam em desenvolvimento. Revogar sessões bloqueia sua renovação; um JWT já emitido continua sujeito à expiração e às políticas da aplicação.
- Atualização de dependências requer preparar o plano com preview identificado, parar esse preview em janela autorizada e aplicar com `--with-dependencies`. Instalação e árvore de dependências são conferidas em candidato isolado; scripts de instalação não executam e a validação funcional do aplicativo segue pelos gates habituais. Dependências privadas, workspaces ou fontes fora do contrato público exigem revisão separada. Personalizações divergentes são preservadas e relatadas.
- Recuperação automática de uma reserva de edição exige identidade do turno e prova de encerramento do host e de seu grupo de processos. Comandos genéricos, reservas legadas e ambientes sem essa prova conservam o impedimento explícito para não competir com um processo ainda vivo.
- `functions-test` diagnostica a assinatura e a versão do hook de email instalado. Não comprova o comportamento de uma função arbitrária nem a entrega de um email. Convites aceitos e configuração de login salva também são distinguidos de entrega ou login realmente testados.
- Leitura, permissões e testes continuam sendo exigidos. Credenciais ausentes, consentimentos externos e funcionalidades que um provedor não expõe por API não podem ser inventados pelo motor.
