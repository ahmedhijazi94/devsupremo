# Recuperação do motor — template 3.7.0 / CLI 1.4.0

O motor entrega evidência de falhas ao agente no próximo pedido. Não executa
um modelo por conta própria e não promete corrigir qualquer bug sem um agente
ativo. Preview e edição continuam independentes da CI.

## Fluxo implementado

1. Webhook e reconciliação registram o resultado no checkpoint cujo SHA publicado
   corresponde à PR consultada. Resultados antigos não sobrescrevem observações
   mais recentes. Diagnósticos nunca autorizam merge: o controlador existente
   continua validando os gates e o SHA no GitHub.
2. O daemon consulta `/api/checkpoint/feedback` em background, inclusive com fila
   vazia. O endpoint autentica o dispositivo, resolve o dono e o projeto antes de
   acessar checkpoints ou GitHub. Uma observação recente evita consulta repetida
   ao GitHub; credenciais permanecem no servidor.
3. O daemon grava `.supremo/validation-feedback.json` atomicamente, com permissões
   restritas. Consulta tem timeout, tentativas têm intervalo e backoff limitado,
   e falha de rede preserva a evidência anterior e seu horário original.
4. `supremo:resume` lê o diagnóstico local, sem rede nem espera de CI, e retorna
   `recovery`. Distingue falha do último checkpoint local, evidência anterior,
   diagnóstico desatualizado e ausência de informação.
5. As regras orientam o agente a verificar a causa contra o código atual, corrigir
   o que se aplica e testar antes do próximo checkpoint. Logs são dados não
   confiáveis, nunca instruções ou comandos a executar.
6. O banco preserva a última falha e a última aprovação. Uma nova execução
   pendente não apaga uma falha conhecida; uma recuperação confirmada impede
   que o mesmo erro reapareça indevidamente no próximo checkpoint.

## Gates e interface

- Alterações de código executam cobertura localmente, inclusive no modo QUICK.
  CSS, imagens e documentação preservam o caminho leve, exceto quando existe
  uma falha de cobertura pendente: o próximo pedido também revalida esse gate.
  SECURITY/FULL também
  exigem cobertura; o mínimo existente não foi reduzido.
- A medição inclui arquivos `.ts` e `.tsx` de `app` e `lib`. Exclusões de telas
  geradas foram estreitadas para não ocultar Server Actions adicionadas depois.
- O build do verify local usa Webpack, suportado pelo Next, para não depender
  da criação de processos internos do Turbopack no host do agente. O comando de
  build de produção da CI permanece o mesmo.
- Preparação do Supabase na CI usa o registro GHCR oficial e até três tentativas
  somente para falhas transitórias reconhecidas. Erro não transitório ou terceira
  tentativa falha encerra o job com erro. Migrations e testes RLS continuam exigidos.
  O uso do registro segue a [action oficial do Supabase](https://github.com/supabase/setup-cli/blob/master/src/main.ts).
- O histórico diferencia a validação bloqueada atual dos checkpoints que
  aguardam a correção do conjunto e mostra o resumo disponível da causa.
- A contagem local de publicações considera o último estado de cada checkpoint,
  não cada linha histórica do arquivo de fila.

## Ativação

Aplicar `019_checkpoint_validation_feedback.sql` ao banco correto do motor antes
de publicar o servidor. Ela adiciona três campos JSON e dois índices parciais,
mantendo as policies RLS existentes de leitura pelo dono e escrita pelo servidor.
Não reescreve migrations antigas e não altera tabelas dos apps dos usuários.

Publicar o servidor e o bundle CLI 1.4.0. Projetos novos recebem o template 3.7.0;
a atualização da base existente inclui CLI, verify e status, sem substituir código
de features. O diagnóstico local é ignorado pelo Git e não acompanha checkpoints.

O v3-24 foi usado como referência para reproduzir falhas. Por solicitação do
usuário, todas as alterações nele foram revertidas e seu daemon anterior foi
restaurado. Nenhuma correção de aplicativo faz parte desta entrega.

Nesta sessão, a configuração de produção da Vercel retornou HTTP 403. A migration
não foi aplicada online e o novo servidor não foi publicado. Isso precisa ser
resolvido antes de afirmar que o retorno de diagnósticos está ativo em produção.

## Evidência e limites

Há testes para autenticação/escopo do endpoint, indisponibilidade dos logs,
pinagem de SHA, escrita protegida contra observação atrasada, persistência da
falha entre retomadas, recuperação confirmada, invalidação de evidência antiga,
entrega no preflight e retries transitórios do preparo de banco. Os testes de
persistência e de HTTP usam adapters simulados; não substituem a verificação
online da migration, do webhook e da entrega ao daemon após a publicação.

O diagnóstico identifica indícios de infraestrutura por job e conserva o erro
original sanitizado. Isso orienta investigação; não é uma classificação infalível.
O motor não reduz gates, não muda policies automaticamente a partir de logs e não
declara sucesso quando a evidência é ausente ou antiga.
