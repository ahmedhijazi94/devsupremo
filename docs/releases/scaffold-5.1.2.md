# Scaffold 5.1.2 e CLI 1.11.0

Esta versão permite reutilizar credenciais de API no motor por referência, sem
expor seu valor ao agente. O formulário autenticado do Supremo continua sendo
usado para cadastrar uma credencial nova. A aplicação das configurações
suportadas ocorre por API no servidor.

O usuário pode escolher guardar a credencial ao preencher o formulário. Sem essa
opção, o motor aplica o valor ao destino e não o mantém no cofre para usos futuros.

## Uso pelo agente

- O agente consulta os metadados das credenciais do projeto e ambiente, escolhe
  uma referência e aplica a credencial a uma solicitação autorizada.
- Credenciais podem ser usadas para Supabase Edge Functions, variáveis privadas
  da Vercel e a configuração nativa de SMTP Resend no Supabase.
- O estado de uma solicitação pode ser consultado pelo identificador. Um outro
  formulário pendente não exige reabrir o navegador após a configuração atual.
- As instruções esclarecem que salvar o formulário já executa a configuração
  suportada por API. O agente não deve repetir essa configuração nos painéis
  dos provedores.
- A referência pode ser removida do cofre. Isso não revoga a chave no provedor
  nem apaga os valores que já foram instalados nos destinos.

## Armazenamento e autorização

O servidor cifra credenciais reutilizáveis com AES-256-GCM, nonce aleatório e
autenticação do identificador, dono, projeto e ambiente. A chave de criptografia
continua fora do banco. O valor cifrado fica em `project_credentials`, sem
permissões de leitura ou escrita para o navegador, inclusive para o dono.
Somente operações do servidor que confirmam o escopo autorizado acessam o cofre.

As senhas administrativas de contas de desenvolvimento não são retidas no cofre.
Valores novos, JSON e conteúdo multilinha permanecem fora dos argumentos da CLI,
dos metadados retornados ao agente e dos registros da operação. As reservas de
entrega continuam impedindo a aplicação simultânea de solicitações concorrentes.

## Compatibilidade e publicação

Aplicar `026_project_credentials.sql` no banco da plataforma antes do deploy.
Ela cria a tabela cifrada, restrições, índices e RLS. Não modifica bancos dos apps.

O baseline de segurança permanece 3.0.0. Os validadores, requisitos de cobertura,
isolamento, preview e integração em background permanecem. Nenhuma dependência
de framework foi alterada; nos lockfiles dos templates apenas a versão da CLI
local muda para 1.11.0. Start recebe 5.1.2 e a linha Next recebe 4.0.14.

A autoridade publicada 4.0.13/5.1.1 foi arquivada a partir do commit original.
Servidor e worker local continuam aceitando projetos intactos dessas versões,
sem regenerar seus validadores.

## Limites

A confirmação do SMTP significa que as configurações foram salvas e verificadas
no provedor; não comprova entrega de email ou verificação do domínio remetente.
Instalar uma credencial genérica não implementa por si só toda a lógica de uma
API. O agente ainda conecta o aplicativo ao serviço conforme o pedido do usuário.
