# Recuperação do preview por excesso de cookies locais

O E2E encontrou HTTP 431 antes de a requisição chegar ao app. O navegador
integrado tinha mais cookies de `localhost` acumulados que o navegador externo.
Cookies não são separados por porta, portanto sessões de vários projetos podem
ultrapassar o limite padrão de headers do Node. Isso não prova um defeito geral
do Codex nem explica outros tipos de falha do preview.

A partir do scaffold 4.0.4, o supervisor inicia o desenvolvimento com 64 KiB e
um preload de recuperação exclusivo desse processo. Quando um cliente local
ultrapassa esse limite em uma primeira navegação GET/HEAD identificada, o servidor
passa a aceitar até 128 KiB e responde com um redirecionamento temporário para o
mesmo caminho. A conexão seguinte usa o novo limite. Processo, porta, código,
banco e cookies continuam intactos. O diagnóstico fica em `.supremo/preview.log`,
sem URL, headers ou valores de sessão.

Não há limpeza de perfis do navegador. Limpar cookies de `localhost` poderia
desconectar outros projetos. A recuperação também não repete escritas, requests
posteriores em conexões persistentes, caminhos ambíguos ou absolutos. Erros acima
do teto continuam recusados. Limites explícitos, handlers próprios de erro HTTP e
processos de produção mantêm seu comportamento. Outros erros HTTP não recebem
essa recuperação.

O preload gerado fica em `.supremo/preview-http/`, fora do Git. Projetos novos
recebem a função quando criados pela versão publicada do motor. Projetos antigos
precisam receber o supervisor atualizado e a regra de ignore; um processo que já
está rodando não pode carregar retroativamente o preload. A atualização do motor
não reinicia os previews existentes.

As provas usam o supervisor gerado, servidores Node e um Next real em pastas
temporárias. Exercitam a recusa original, recuperação, teto, opções herdadas,
produção e continuidade após editar a página; casos adversariais verificam a
ausência de repetição de mutações e redirecionamentos inseguros. Não acessam
cookies reais do usuário nem dependem de mudar permissões do navegador.

A autoridade de publicação reconhece 4.0.4 explicitamente. Os validadores,
scripts e dependências protegidos permanecem idênticos aos de 4.0.3; uma prova
fixa o hash dessa autoridade anterior. A política histórica de 4.0.2 é preservada.

## Validação desta mudança

- 31 testes de recuperação e capacidade, com Node e Next reais; inclui conexões
  reutilizadas, requisições em sequência no mesmo pacote e respostas `Expect`.
- Suíte completa: 1.661 testes em 108 arquivos; cobertura de linhas 95,67%.
- Typecheck, lint, manifesto embarcado e auditoria estrita aprovados. A auditoria
  mantém 13 avisos MEDIUM preexistentes; nenhum CRITICAL/HIGH.
- Build de produção aprovado com Webpack. O Turbopack local falhou por restrição
  do ambiente ao abrir uma porta para seu processo de CSS; a configuração de
  build do projeto foi preservada.
- Gitleaks não estava instalado localmente; a varredura dedicada fica pendente
  na CI. A auditoria estática local não encontrou segredos no código.
