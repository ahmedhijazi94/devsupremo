# Ajustes para desenvolvimento direto no agente

> Registro da primeira etapa. Estado atual: [preparação do novo E2E](e2e-readiness.md).

Verificação local em 5 de setembro de 2026. Prioridade: uso pessoal, agente
externo, preview persistente e verificações assíncronas.

## Alterações concluídas no código

- Removidos transporte MCP, tokens/actions de MCP, rotas do companion v1,
  pacote companion e comandos `connect`/`mcp` da CLI.
- Mantidos GitHub, autorização de projetos e cliente Supabase privilegiado em
  módulos próprios; bootstrap/checkpoints continuam usando esses componentes.
- A fila local virou um journal de eventos. Publicar A não apaga B quando B
  é criado enquanto a requisição de A está em andamento.
- Leitura, criação e atualização de checkpoints são limitadas ao projeto
  autorizado. Colisão de ID não transfere um checkpoint de outro projeto.
- Arquivos vazios válidos são aceitos no changeset.
- Template team não permite entrar em organização alheia apenas informando
  o próprio user_id. Uma migration adicional corrige o template antigo.
- Testes RLS gerados incluem tentativa de autoassociação e fixtures com
  organização real. A auditoria local detecta policies simples vulneráveis
  de associação, considerando DROP posterior nas migrations.
- Novo ARCHITECTURE.md orienta a estrutura dos apps gerados. As regras locais
  distinguem desenvolvimento de produção e preservam um preview saudável.
- CI do Supremo passa a executar testes da CLI e isolamento do SQL team
  em PostgreSQL descartável. Não há espera adicional no ciclo local de edição.

## Validação

- Supremo: 857 testes, 49 arquivos; cobertura de linhas 90,91%.
- CLI: 194 testes, incluindo fila concorrente, restore e sincronização.
- TypeScript sem erros; lint sem erros, com cinco avisos preexistentes.
- Auditoria estática estrita sem achados.
- Build do Supremo e de um app team gerado passaram com Webpack.
- Turbopack não completou: o ambiente recusou sua abertura de porta interna.
- App team gerado: tipos, lint, testes com cobertura e auditoria passaram.
- PostgreSQL descartável: SQL atual bloqueou acesso/alteração entre tenants
  e autoassociação; o SQL vulnerável reproduziu a falha; a migration corretiva
  bloqueou a falha mantendo acesso legítimo. Não é um E2E completo do Supabase Auth.
- Supervisor do preview e bootstrap não foram alterados. Os testes de
  retomada/preview passaram. Nenhum preview existente foi reiniciado.

## Ativação ainda necessária fora desta alteração local

1. Publicar uma nova versão da CLI e atualizar em conjunto a versão pinada e
   o lockfile do template. O número publicado atual foi preservado: o bundle
   local foi reconstruído, mas o pacote do registry ainda contém a versão antiga.
   Daemons existentes precisam passar a usar a CLI nova; isso não exige
   reiniciar o preview. Evitar executar daemons de versões diferentes na mesma fila.
2. Publicar o Supremo atualizado. Remover o endpoint neste checkout não remove
   automaticamente o endpoint de um deploy antigo.
3. Atualizar a base dos projetos existentes e revisar suas regras locais.
   O sincronizador preserva AGENTS.md/CLAUDE.md customizados: não substitui
   automaticamente documentação existente. ARCHITECTURE.md nasce se faltar.
4. Revisar e aplicar a migration de associação no banco correto dos apps team.
   Um fluxo antigo de autoassociação deve ser substituído por criação/convite
   autorizado no servidor. Nenhuma migration remota foi executada nesta tarefa.
5. Configurar banco exclusivo de desenvolvimento quando ainda não existir.
   A documentação orienta essa separação; ela não cria outro banco automaticamente.

## Limites da avaliação

Esses ajustes corrigem falhas específicas; não certificam qualquer app futuro.
Permissões de cada funcionalidade, convites, migrations e comportamento sob carga
continuam exigindo testes. O limitador em memória do Supremo não fornece quota
global entre várias instâncias. O vínculo entre projeto e repositório, usado por
credenciais privilegiadas do GitHub App, merece reforço antes de abrir a plataforma
para outras pessoas. Essas frentes de SaaS não foram implementadas neste escopo.

Migrations e colunas históricas de MCP permanecem para compatibilidade com bancos
existentes. Nenhum dado remoto, credencial ou projeto do usuário foi apagado.
