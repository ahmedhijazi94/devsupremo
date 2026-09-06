# Supremo: arquitetura dos projetos e ideias do Lovable

Avaliação em 6 de setembro de 2026. Código examinado: `53bb9ca`, template 3.7.0 / CLI 1.4.0. O [PR #54](https://github.com/ahmedhijazi94/devsupremo/pull/54) contém a recuperação do motor. Este documento é uma análise posterior, não uma implementação das propostas abaixo.

## Parecer

O Supremo já fornece uma base tecnicamente adequada para desenvolver apps web, sistemas internos e SaaS com dados privados e organizações. Não há motivo demonstrado para trocar Next.js + Supabase nem adicionar microserviços por padrão. O ponto forte é combinar autorização, isolamento de dados, código próprio e validação independente do agente.

Ainda não considero os projetos gerados automaticamente prontos para alta carga ou operações críticas. Há diferença entre a stack permitir crescer e um app ter capacidade comprovada. Paginação, filas, idempotência, metas de latência, restauração e observabilidade aparecem como orientação arquitetural, mas não como uma camada operacional completa gerada e verificada. Cada app continua precisando de testes das suas regras e da sua carga.

Esta é uma revisão do código e da documentação; não é pentest, teste de carga ou certificação. Os 993 testes do motor e 208 da CLI não comprovam a segurança nem a capacidade de todos os apps produzidos.

## O que já é concreto no Supremo

| Área | Evidência no repositório | Avaliação |
| --- | --- | --- |
| Autorização e isolamento | `src/lib/templates/project-files.ts`: migrations de usuário/organização, policies de memberships; `src/lib/templates/rls-tests.ts` e `assets/rls/isolation.ts.txt` | Base forte, com testes reais de acesso cruzado e inventário que exige prova executada para tabelas protegidas detectadas. Padrões particulares do negócio ainda exigem testes próprios. |
| Ambientes de banco | `src/lib/database-environment/policy.ts`, `service.ts`; `packages/cli/src/database.ts` | O servidor só autoriza operação automática em development registrado e ref correspondente; produção/desconhecido falham fechados. |
| Integração | `src/lib/github/merge-policy.ts` e `merge-controller.ts` | Exige checks completos e verdes do SHA correto. A garantia depende também da proteção configurada no GitHub; modo gerenciado não impede sozinho um push externo direto. |
| Proteção do navegador | Geradores `nextConfig` e `proxyFile` em `project-files.ts` | CSP com nonce e headers de segurança já fazem parte do template. Não substituem autorização do servidor. |
| Continuidade do agente | AGENTS, documento de arquitetura, supervisor e recuperação do PR #54 | Preview persistente e diagnóstico entre pedidos. A entrega online do novo feedback ainda precisa da migration e publicação. |
| Crescimento | Função `architectureMd` em `project-files.ts` | Recomenda paginação, índices, jobs e idempotência; isso não demonstra implementação automática desses controles. |

## Lacunas que priorizaria

### P0 — proteção contra abuso que funcione com várias instâncias

No motor, `src/proxy.ts` usa um `Map` em memória para limites e lê `x-forwarded-for`. Esse estado não é compartilhado entre instâncias e se perde em reinícios; o cabeçalho exige uma fronteira de proxy confiável. Também não é um limitador universal para todas as Server Actions. No template examinado não identifiquei um componente padrão equivalente com armazenamento distribuído.

Proposta: controle atômico compartilhado, limites por identidade/tenant/operação, tamanho de payload e custo; verificar a origem confiável do IP e testar concorrência. Cada operação sensível deve aplicar o controle no servidor. Onde a policy permite INSERT público direto via PostgREST, um limite só no Next é contornável: o controle precisa alcançar essa entrada ou ela precisa ser redesenhada. RLS preserva permissões, mas não resolve abuso volumétrico por si só.

Critério: a mesma cota permanece válida em duas instâncias simultâneas; não há caminho direto que contorne a proteção; indisponibilidade do limitador tem comportamento explícito por risco.

### P0 — provar o fluxo solicitado, além de build e cobertura

O template gera `e2e/smoke.spec.ts`, útil como base. Um smoke genérico não comprova uma nova feature. O caso “Entrar deve abrir o login” precisa de uma asserção desse resultado; formulário precisa provar envio, persistência, estado de erro e permissões aplicáveis.

Proposta: associar cada alteração funcional a critérios de aceitação e testes de regressão. Guardar cenário, SHA, ambiente, resultado, trace e console/rede sanitizados. Esses dados alimentam o mesmo canal de recuperação da CI. Executar os testes em ambiente próprio, com usuários sintéticos de papéis diferentes.

Critério: bug reproduzido antes da correção e teste aprovado depois; falha funcional não vira sucesso por cobertura alta. Logs e páginas testadas continuam sendo dados não confiáveis.

### P0 — promover e recuperar produção com evidência

A proteção contra migrations automáticas em produção já existe. O que não está demonstrado é um fluxo completo de promoção com backup verificado, ensaio de restauração e canário da versão publicada.

Proposta: promoção vinculada ao SHA validado e aos hashes das migrations, identificação independente do banco alvo, verificação de divergência de schema e registro auditável. Preferir migrations compatíveis em etapas; mudanças destrutivas precisam de revisão específica. Restaurar código não deve prometer restaurar dados.

Critério: ensaio de restore, metas de perda de dados/tempo de recuperação definidas pelo app e canário que valida login e uma operação central após publicação.

### P1 — transformar conhecimento em contratos verificáveis

O documento de arquitetura já existe e deve continuar editável. Acrescentaria um manifesto pequeno com modelo de dados, matriz de acesso, ambientes, integrações, cenários críticos e requisitos de carga. Regras de segurança obrigatórias precisam ser validadas por código/CI, não depender apenas de instruções do agente.

O Supremo já tem um gate executável de inventário: `scripts/rls-isolation-inventory.mjs` analisa o histórico de migrations, segue referências e reconhece sinais de ownership; `scripts/rls-isolation-gate.mjs` exige provas realmente executadas e rejeita ausência de cobertura. Isso é mais forte que apenas gerar um teste inicial. A extensão proposta é cobrir explicitamente outras superfícies — Storage, RPC privilegiada, papéis e regras particulares do negócio — e confrontar o inventário com o schema efetivamente implantado. O analisador SQL e seus padrões não são uma prova universal de autorização.

### P1 — operação e crescimento por necessidade

Gerar módulos opcionais, não infraestrutura pesada em toda landing page:

- SaaS: paginação limitada, índices validados com consultas representativas, orçamento de conexões, isolamento de cache por tenant e quotas.
- Integrações/pagamentos: webhooks assinados, proteção contra replay, idempotência e efeitos externos testados em sandbox.
- Trabalho demorado: fila durável com reserva do job, tentativas limitadas e fila de falhas; evitar depender da vida útil de uma requisição web.
- Operação: identificador de requisição, erros estruturados sem segredos, métricas de latência/erro/fila e alertas com retenção definida.

Critério de escala: escolher uma carga realista por app, medir p95/p99, taxa de erro, consultas e conexões; nenhum número de usuários é garantido apenas pela stack.

## Ideias aproveitáveis da documentação oficial do Lovable

| Ideia documentada | Adaptação ao Supremo |
| --- | --- |
| [Knowledge por workspace e projeto](https://docs.lovable.dev/features/knowledge) | Separar regras comuns do motor das decisões do app. Manter resumo curto e rastreável. No Supremo, uma instrução de projeto não deve revogar um bloqueio obrigatório de segurança. |
| [Testes de navegador, frontend e backend](https://docs.lovable.dev/features/testing) | Selecionar validação pelo comportamento alterado e integrar evidências ao próximo pedido. A documentação descreve captura de console, rede e erros durante essas ferramentas. |
| [Visão de segurança](https://docs.lovable.dev/features/security-view) e [scans](https://docs.lovable.dev/features/security) | Mostrar achados com gravidade, evidência, revisão analisada e validade; separar ausência de scan de aprovação. Preservar bloqueio de riscos críticos no Supremo. |
| [Logs de serviços](https://docs.lovable.dev/features/logs) | Unir erro de aplicação, banco e autenticação ao diagnóstico do projeto, com acesso por dono/ambiente, coleta mínima e remoção de dados sensíveis. |
| [Monitoramento de projetos](https://docs.lovable.dev/features/project-monitoring) | A documentação descreve revisão de código e erros de visitantes, com achados levados ao editor. No Supremo, propor diagnóstico e correção testável; nunca executar mudanças de produção diretamente a partir de um log. |
| [Jobs](https://docs.lovable.dev/features/jobs) | Dar visibilidade ao histórico das tarefas do app. Minha extensão arquitetural é exigir execução durável e idempotente onde necessário; a página não demonstra essa garantia para todo job. |
| [Drafts](https://docs.lovable.dev/features/drafts) | Oferecer experimentação por branch e preview separado. O banco também precisa ser isolado quando houver escrita de teste. |

### Escolhas que eu não copiaria

A documentação atual diz que drafts compartilham dados reais do projeto. Separação de código não é isolamento de dados: no Supremo, testes com escrita devem continuar em banco dedicado. A página legada de [Test/Live](https://docs.lovable.dev/features/environments) informa que a funcionalidade deixou de estar disponível para novos projetos Cloud em 24 de março de 2026; portanto não a considero uma capacidade atual universal do Lovable.

A [visão geral de segurança](https://docs.lovable.dev/features/security) informa que publicar com achados críticos ainda pode ser permitido, embora desaconselhado, e que existem controles administrativos mais rígidos. No Supremo, manteria os gates críticos obrigatórios.

As [boas práticas do Lovable](https://docs.lovable.dev/tips-tricks/security-best-practices) reforçam autorização/validação no servidor e RLS. Isso é compatível com o Supremo; não exige trocar Server Actions por Edge Functions. A fronteira de confiança e os testes importam mais que o nome do mecanismo.

## Ordem recomendada

1. Integrar o PR #54, aplicar a migration no banco correto e provar a entrega CI → daemon → próximo pedido com um canário descartável.
2. Implementar proteção distribuída contra abuso e contratos de aceitação com E2E específicos.
3. Completar promoção/recuperação de produção e telemetria sanitizada.
4. Transformar a arquitetura do app em contratos verificáveis e disponibilizar módulos de escala sob demanda.

O objetivo é aumentar o que o motor consegue demonstrar sobre cada projeto. Acrescentar mais texto ao prompt, sozinho, não entrega essa garantia.
