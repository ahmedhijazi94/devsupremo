# E2E v3-21: banco e tempo de desenvolvimento

## Evidências

Comparação: `b33ea83` (04/09, antes das mudanças de 05/09) → `b25d397`
(segurança/design) → `04e2d1f` (autorização de development).
Inspecionado o checkout `/Users/ahmedhijazi/dev/v3-21/v3-21` em 05/09.

- Antes: as regras mandavam aplicar migrations pelo Supabase CLI no remoto linkado.
- Depois: escritas passaram a exigir development registrado e a API autenticada
  do Supremo. Essa separação é necessária; o link sozinho não autoriza produção.
- O bootstrap do v3-21 registrou development, com `automaticMigrations: true`.
  Portanto, o problema observado não era ausência dessa classificação local.
- Executar a CLI 1.3.0 do próprio E2E, `db status`, no ambiente do agente reproduziu
  `Dispositivo sem autorização. Execute o bootstrap.` antes de consultar a API.
  A leitura do keychain estava no processo do agente. Já os checkpoints eram
  publicados pelo daemon iniciado no terminal autorizado.
- A migration `20260905183006_create_suggestions.sql` contém o trigger padrão
  `EXECUTE FUNCTION public.set_updated_at()`. Mesmo resolvida a credencial,
  a regra anterior de migration recusaria esse EXECUTE como SQL dinâmico.
- O log do preview contém respostas 404, compatíveis com as capturas, mas não há
  evidência suficiente para atribuí-las a um restart ou build específico.

## Correção preparada

CLI 1.3.1 / scaffold 3.6.1:

- Comandos de banco usam fila local com operações enumeradas, prazo de validade,
  escrita atômica e resposta correlacionada por UUID. O daemon lê a credencial.
  O agente não recebe secrets e não escolhe endpoint/ref pela fila.
- O worker de banco roda independentemente do upload/backoff dos checkpoints.
  Pedidos expirados não iniciam operações. Timeout não é apresentado como sucesso;
  uma escrita já enviada é reconciliada pelo histórico idempotente de migrations.
- O servidor continua validando dispositivo, dono, vínculo e development antes
  de escrever; produção, desconhecido, SQL destrutivo e dinâmico seguem recusados.
- Exceção estreita para a chamada sem argumentos ao trigger de timestamp do
  scaffold. O restante da migration continua passando pelo guard de SQL/RLS.
- Verificações locais independentes em paralelo, com tempo por etapa. Todos os
  checks precisam passar antes do build e do checkpoint; CI continua obrigatória.
- Regras evitam rodar tipos/lint/testes antes do verify que já os inclui e evitam
  testes que apenas reproduzem texto/classes de uma alteração cosmética.

## Velocidade: resultado e limite

Em cópia temporária do HEAD do v3-21, reutilizando as dependências instaladas,
o mesmo `verify quick` foi executado na ordem anterior/novo/novo/anterior:

| Verificador | Tempo total |
| --- | ---: |
| Anterior, primeira rodada | 4,46 s |
| Novo, primeira rodada | 1,83 s |
| Novo, segunda rodada | 2,13 s |
| Anterior, segunda rodada | 3,18 s |

Checkout sem mudanças funcionais: tipos, lint e secret scan reais, seleção de
testes sem arquivos afetados. Não é um benchmark de uma tarefa inteira do agente.
Esses segundos não explicam os 4–8 minutos das capturas. O diff de ontem para hoje
adicionou contexto de arquitetura/design e revisão visual em mudanças estruturais;
não há trace das chamadas do agente para quantificar sua contribuição. Não foi
prometida volta a 40 segundos por tarefa.

## Validação

- 910 testes do Supremo; cobertura de linhas de 91,43%.
- 201 testes da CLI, incluindo fila sem keychain no cliente, resposta de recusa,
  rejeição de pedidos inválidos/expirados e ausência de duplicação durante operação lenta.
- Teste executável prova checks simultâneos e build somente depois de todos passarem.
- Migration real do v3-21 aceita pelo guard corrigido, sem aplicá-la ao banco remoto.
- Typecheck sem erros; lint sem erros (cinco avisos preexistentes); auditoria
  estrita sem achados. Build de produção com Webpack aprovado; Turbopack bloqueado
  pela permissão de abrir porta interna neste ambiente.
- CLI 1.3.1 instalada e executada pelo pacote HTTP com hash, sem registry externo.

## Disponibilização

Esta correção está no repositório local. Não publica o backend nem altera o banco
ou o checkout do E2E. Para retestar ponta a ponta, publicar o guard atualizado,
distribuir o scaffold/CLI e reiniciar uma vez somente o daemon antigo no terminal
autorizado. O preview e a identidade do dispositivo devem ser preservados.
Então executar `db anonymous-auth`, `db migrate` e validar duas sessões isoladas
no navegador. As verificações locais não substituem essa rodada remota final.
