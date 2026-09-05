# Correção do fluxo de banco — E2E v3.20 → v3.21

O provisionamento criava o Supabase e aplicava o schema inicial, mas não registrava
se o banco era desenvolvimento ou produção. O bootstrap entregava somente o ref,
URL/chave pública e dados de link. As regras pediam confirmação humana antes de
escrever em um remoto. A recusa do agente era coerente com essas regras; faltava
uma autoridade de ambiente no produto.

O scaffold também não fornecia configuração nem helper de identidade anônima. No
v3.20, a falha de `signInAnonymously` mudava a feature para armazenamento local,
mas o pedido era por persistência real. Os três alertas do CI eram falsos positivos
`generic-api-key` em destructuring de imports dinâmicos no bundle da CLI (commit
inicial, linhas 4633, 5050 e 5084). A mudança evita essa forma de código; não cria
allowlist. O CI do Supremo agora também varre o bundle no formato distribuído,
fora das exceções existentes no repositório do control plane.

## Contrato implementado

- Migration 018 cria `project_database_environments`, com RLS e sem acesso de
  `anon`/`authenticated`. O registro vem exclusivamente da criação do banco pelo
  provedor; não há backfill presumindo que bancos antigos sejam development.
- Bootstrap entrega a classificação e grava `.supremo/database.json`, ignorado
  pelo Git. Esse arquivo é informativo. Cada escrita reconsulta a autoridade no
  servidor; arquivo local, ref fornecido pelo cliente e nome do banco não autorizam.
- `supremo db status` retorna JSON. `supremo db migrate` aplica arquivos versionados
  e mantém o histórico transacional com lock, detecção de conteúdo alterado, retry
  idempotente e rollback. Recusa produção, desconhecido, vínculo divergente e
  operações destrutivas/dinâmicas. Também confere o banco usado pelo preview.
- `supremo db anonymous-auth` configura apenas a opção anônima no development.
  Preserva CAPTCHA, limites, providers e confirmação de email. Confere a opção na
  Management API e a disponibilidade efetiva em Auth: o E2E mostrou atraso entre
  a confirmação da configuração e a aceitação real do login.
- `lib/supabase/anonymous.ts` é gerado para todos os tipos de app, inclusive public.
  Reutiliza cookies, compartilha criação concorrente e aceita token de CAPTCHA.
  A feature continua validando sessão e entradas no servidor e isolando linhas
  com `auth.uid()` em USING/WITH CHECK. Falhas nunca viram dados locais/sucesso falso.
- As regras reutilizam o contexto dos documentos já lidos. DESIGN.md é consultado
  para alterações visuais e relido quando mudar ou faltar contexto. Não há cache
  que possa ignorar instruções de skills do host. Não há histórico suficiente do
  agente anexado para quantificar a latência dessas skills externas.

Supervisor, heartbeat, checkpoints assíncronos, Restore e o caminho de retomada
permanecem com o mesmo comportamento. Preview/edição não esperam CI.

## Verificação

- E2E em Supabase novo descartável: schema inicial → development → migration de
  feature aplicada → retry idempotente → duas sessões anônimas reais → persistência
  e refresh → isolamento SELECT/INSERT/UPDATE/DELETE. Banco removido ao final.
- PostgreSQL 14 local descartável: migration 018, bloqueio de acesso/alteração do
  registro por usuários, aplicação real, retry, alteração de migration recusada,
  rollback de DDL e histórico, RLS e recusa de produção.
- Supremo: 905 testes, cobertura de linhas de 91,42%; CLI: 196 testes.
- Suítes de unidade/API: dispositivo revogado, dono errado, refs divergentes,
  produção/desconhecido, payload inválido, erros do provedor e prontidão de Auth.
- Gitleaks 8.21.2 no scaffold gerado: zero achados, sem allowlist.
- Build de produção validado com `npm run build -- --webpack`; o Turbopack deste
  ambiente falhou ao abrir uma porta interna. O scaffold também compila e passa
  em typecheck/lint/testes. O lint do Supremo tem cinco avisos preexistentes.

Reprodução do teste remoto (variáveis são IDs da conta autorizada, não tokens):

```sh
SUPREMO_TEST_CREATE_DEV_DATABASE=1 \
SUPREMO_TEST_ACCOUNT_ID=<account-id> \
SUPREMO_TEST_OWNER_ID=<owner-id> \
node --env-file=.env.local --import tsx scripts/test-development-database.mts
```

O teste remoto recusa refs existentes e remove somente o banco retornado pela
criação da própria execução. Requer capacidade para criar um Supabase temporário.
O teste local exige um PostgreSQL descartável e `SUPREMO_TEST_DATABASE_URL` local;
execute `node --import tsx scripts/test-development-database-local.mts`.

## Publicação para o v3.21

A PR não aplica a migration 018 ao control plane em produção e não faz merge.
Antes de disponibilizar a versão, é necessário aplicar essa migration pelo fluxo
separado de promoção do control plane e publicar a versão da PR. Sem a tabela,
o sistema falha explicitamente ao verificar o ambiente. Bancos legados continuam
sem autorização automática; novos projetos recebem o contrato na criação.

A configuração anônima de desenvolvimento não é uma configuração de produção.
Promover o app exige banco separado, configuração de autenticação e revisão de
proteção contra abuso. Limpar cookies perde a identidade anônima daquele navegador;
o helper não promete recuperação nem sincronização entre dispositivos.
