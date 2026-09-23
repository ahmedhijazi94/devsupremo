# Scaffold 5.1.1 e CLI 1.10.0

Esta versão amplia as operações do motor para que o agente solicite uma chave
no formulário seguro do Supremo e aplique a configuração suportada pelo servidor.
Não altera os aplicativos existentes nem reinicia seus previews.

## Configuração pelo formulário

- O fluxo genérico de secrets continua aceitando nomes privados válidos para
  Supabase Edge Functions e variáveis de ambiente da Vercel. O agente informa
  finalidade, destino e ambiente; o usuário preenche somente o valor.
- A configuração de email com Resend passa a ter uma operação própria. O
  formulário envia a chave diretamente ao servidor, que configura o SMTP nativo
  do Supabase e confirma os dados não secretos retornados. Não é necessário
  conectar a Vercel para essa operação.
- A senha de uma conta de desenvolvimento pode ser definida por um pedido
  específico no mesmo formulário. O usuário escolhe a nova senha; ela não é
  recebida como argumento da CLI, gravada na fila do agente ou devolvida na resposta.
- A configuração de autenticação aceita recuperação por código ou link. O
  servidor aplica templates controlados com o token emitido pelo Supabase e
  confirma assunto e conteúdo após a alteração. O motor não cria códigos fixos.
- O agente pode consultar o estado da configuração de SMTP e do template de
  recuperação sem receber a chave, a senha SMTP ou o conteúdo do email.

O preenchimento continua sendo feito pelo usuário em um formulário autenticado
do Supremo, aberto pelo agente. Ele não é um campo nativo do chat do agente.
O restante da configuração implementada é executado pelo motor. A instalação
genérica de um secret não implementa automaticamente a lógica de qualquer API;
o agente ainda precisa conectar o aplicativo ao serviço escolhido quando isso
fizer parte do pedido.

## Compatibilidade e segurança

Os valores permanecem fora do chat, dos argumentos e dos registros do agente.
As operações validam o dono, o projeto, a conta conectada e o ambiente no servidor.
Uma troca de vínculo ou uma revogação impede a aplicação ao destino anterior.
O formulário de senha administrativa é restrito a desenvolvimento.

O baseline de segurança continua em 3.0.0. RLS, CSRF, limites de cobertura,
validação e integração em background permanecem inalterados. Nenhuma dependência
de framework foi atualizada. Nos lockfiles dos templates, somente a entrada
do pacote da CLI muda para 1.10.0.

Novos projetos Start recebem 5.1.1; a linha Next recebe 4.0.13 pelas mudanças
compartilhadas de instruções e pacote. A autoridade de validação 4.0.12/5.1.0 foi
arquivada a partir do commit publicado e permanece aceita pelo servidor e pelo
worker local. O worker também reconhece o arquivo já existente de 4.0.11/5.0.1.
Nenhum projeto existente precisa reescrever seus validadores para ser reconhecido.

## Publicação do motor

Aplicar `025_secret_request_configuration.sql` no banco da plataforma antes do
deploy desta versão. A migration adiciona somente metadados dos pedidos e da
reserva de envio; não altera bancos dos aplicativos nem armazena credenciais.
Pedidos de segredo em envio não podem ser dispensados até a conclusão ou
expiração da reserva. Uma aba antiga não confirma outro valor como se tivesse
sido aplicado.

## Limites da verificação

Os testes das integrações usam respostas controladas dos provedores. A confirmação
do SMTP atesta as configurações salvas, não uma entrega real de email ou a
verificação do domínio remetente. Esta versão não declara suporte automático
a todas as configurações de todos os provedores.

A regressão de compatibilidade usa arquivos extraídos do release publicado
4.0.12/5.1.0, cobrindo as duas stacks e os três perfis de projeto. Ela verifica a
aceitação dos arquivos intactos e a rejeição de validadores, identidade da CLI
e workflows adulterados.
