# Autonomia de desenvolvimento por padrão

A criação de um projeto autoriza todas as capacidades disponíveis do motor no
ambiente de desenvolvimento desse projeto. O formulário informa esse padrão,
sem exigir uma configuração adicional de permissões. A migration 043 cria a
política e sua auditoria na mesma transação da criação do projeto; se uma delas
falhar, o projeto também não é criado.

A política inicial fica habilitada, com as 29 capacidades, sem uma lista restrita
de recursos ou computadores. Continuam obrigatórios a identidade do dono, o
vínculo do dispositivo ao projeto e a classificação verificada do banco como
desenvolvimento. Os limites existentes de 25 registros por operação e 60
operações por hora são mantidos. Não há concessão automática para produção.

Projetos existentes e autorizações desativadas ou personalizadas não recebem
backfill. O dono pode ajustar a autorização em **Automação**. O botão
**Selecionar perfil completo de desenvolvimento** seleciona todas as capacidades
e remove restrições antigas de recursos (como `engine.tools`), preservando os
computadores e limites já escolhidos; salvar aplica uma nova revisão auditada.

O catálogo TypeScript é a fonte das capacidades do perfil na interface. O teste
PostgreSQL de `default-automation.postgres.test.ts`, executado na CI com banco
descartável, compara a política real criada pelo trigger com esse catálogo e
verifica isolamento entre donos, revogação, projetos anteriores e rollback.
Uma capacidade nova exige atualizar também o padrão do banco em nova migration.

A mudança reside no servidor e no banco do próprio Supremo. Não exige nova CLI
nem alterações nos bancos ou arquivos dos aplicativos. As permissões do host do
agente e os consentimentos exigidos por provedores continuam sendo externos ao
Supremo.
