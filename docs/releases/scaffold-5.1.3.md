# Scaffold 5.1.3 e CLI 1.12.0

Esta versão amplia as operações autorizadas do motor para publicação de Supabase
Edge Functions, Send Email Hook, agendamento de funções e painel dos dados conectados.
O agente utiliza o canal autenticado do projeto e APIs dos provedores, preservando
o uso do formulário seguro e das referências do cofre para credenciais privadas.

## Funções e envio de email

O motor aceita uma seleção explícita e limitada de arquivos de código do projeto,
confirma o vínculo e o ambiente do banco e publica a função no Supabase.
Arquivos ocultos, caminhos de credenciais e leituras por links simbólicos não são
aceitos. A operação não exige preencher o painel do provedor no navegador.

O Send Email Hook permite conectar o envio de autenticação a uma função que usa
a API HTTP de email. A assinatura do hook deve ser verificada antes de processar
seu conteúdo. Essa função é responsável pelo conteúdo do email e pela escolha
entre código e link de recuperação.

## Diagnóstico da recuperação

Quando um hook de envio está ativo, o motor identifica essa modalidade e informa
que alterar o template SMTP não altera o email renderizado pela função. A
configuração do template não é apresentada como concluída nesse caso.

A resposta HTTP 400 do Supabase é classificada quando indica a restrição à
personalização de templates no provedor de email padrão. O diagnóstico explica
o requisito de SMTP próprio ou o uso de um Send Email Hook, sem expor o corpo
privado retornado pelo provedor. Outros erros permanecem como operação não
confirmada, sem atribuir automaticamente a causa às permissões da conta.

## Compatibilidade

O baseline de segurança permanece 3.0.0. Start recebe 5.1.3, Next recebe 4.0.15
e a CLI passa a 1.12.0. Nos lockfiles dos templates, somente a versão da CLI
local muda; nenhuma dependência de framework é atualizada.

As políticas publicadas 4.0.14/5.1.2 foram congeladas a partir do commit
`3dd9cef00ccaba3dfa415c2faa1a4777bea3ad1a`, junto dos arquivos originais das duas
stacks e dos três perfis. Servidor e worker local continuam reconhecendo essas
versões intactas e recusando alterações nos validadores e na identidade das
ferramentas. Os projetos existentes não precisam começar do zero.

## Limites da confirmação

Configuração salva, função publicada e entrega real de email são resultados
distintos. O motor deve informar o que conseguiu verificar; uma configuração
aceita pelo provedor não comprova entrega, reputação ou domínio remetente.
Publicações e mudanças de rotinas aceitam desenvolvimento ou produção explicitamente
selecionada e confirmada pelo motor. Ambientes desconhecidos não recebem alterações.
Migrations automáticas continuam restritas ao desenvolvimento.

## Dados e serviços no Supremo

O projeto oferece tabelas public e seus registros, editor SQL de leitura, usuários,
buckets, funções, jobs, histórico, logs e uso. Cada operação verifica sessão, dono,
conta, banco e ambiente; trocas durante uma chamada interrompem o acesso. Consultas
são limitadas e campos sensíveis são ocultados. Métricas indisponíveis permanecem
indisponíveis; o painel não inventa faturamento ou cotas do provedor.

## Rotinas por API

O manifesto de jobs preserva atualizações SQL declarativas e acrescenta funções
do mesmo projeto. Supabase Cron, pg_net e Vault executam chamadas assinadas com HMAC;
a assinatura é criada no banco e instalada na função pelo servidor. A CLI fornece
um handler inicial autenticado, que exige implementação da tarefa e idempotência.
O histórico distingue execução SQL, envio HTTP, resposta pendente e HTTP sucesso/falha.
Respostas HTTP são transitórias (seis horas); o relatório sinaliza expiração.

## Atualização da plataforma

Aplicar 027_function_operation_leases.sql somente ao banco do Supremo antes do deploy.
Ela serializa publicação de funções e configuração de hooks por banco conectado,
com lease durável, RLS e operações restritas ao servidor. Não altera dados dos apps.
O painel e as APIs entram em funcionamento na plataforma; a CLI e as instruções
atualizadas chegam aos apps pelo upgrade do motor, sem recriar o projeto.
