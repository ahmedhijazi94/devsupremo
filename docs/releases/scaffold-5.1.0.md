# Scaffold 5.1.0 e CLI 1.9.0

Esta versão melhora a primeira experiência dos novos projetos gerados e aproxima
as APIs dos componentes do padrão encontrado no Hello SupaAuth do Lovable.
Mantém TanStack Start, Vite, SSR, cookies de sessão e a autoridade do servidor.
Não aplica mudanças ao v7 nem migra projetos existentes automaticamente.

## Mudanças

- Home, login/cadastro e área privada com apresentação compartilhada, estados
  acessíveis de carregamento, erro e página não encontrada.
- Cadastro acessível por `?mode=signup`; mudar entre entrar e cadastrar preserva
  os campos preenchidos. O fluxo de autenticação, callback e saída foi mantido.
- Button com composição `asChild`, Card completo, Dialog, Tabs, DropdownMenu,
  Tooltip, Label e Separator. As APIs anteriores continuam disponíveis.
- Tokens semânticos e fonte local com fallback válido; temas claro/escuro e
  visualização em celular. Não são carregadas fontes de terceiros.
- Saudação de referência em `/examples`; `/design-system` continua exclusivo
  do desenvolvimento. Os exemplos ficam separados da página inicial.
- Instruções orientam a reutilização da estrutura e a leitura dos arquivos
  relevantes, preservando preview rápido e validação em background.
- Helper reutilizável de identidades sintéticas nos testes RLS, com limpeza
  explícita mesmo após falhas parciais. Regras específicas da feature continuam
  exigindo suas próprias provas; o helper não substitui testes de isolamento.
- Diagnóstico opcional de erros não tratados no navegador, somente no preview
  local. Envia enums, contagens e localização reconhecida; não grava mensagens,
  stacks, conteúdo da página, cookies ou parâmetros de URL. Retenção de 15
  minutos, origem exata, limites de tamanho/frequência e reset por inicialização.
- O contexto do turno apresenta essas observações como informação, sem alterar
  autorização, checkpoints, recuperação ou gates. Ausência de eventos não
  comprova saúde. A configuração Vite e seu plugin têm integridade protegida.
- Diagnóstico de CI distingue etapa não executada, cancelada e tempo excedido.
  Indisponibilidade de ambiente só é atribuída quando há evidência da etapa.

## Compatibilidade e segurança

Nenhuma dependência existente do framework foi atualizada. Foram acrescentadas
cinco dependências Radix utilizadas pelos componentes, com versões fixas.
Os critérios de cobertura e de integração permanecem iguais. CSP com nonce,
CSRF, importações exclusivas do servidor, verificação da identidade e migrations
de isolamento não foram enfraquecidos.

A política anterior 4.0.11/5.0.1 está arquivada e continua reconhecida. A linha
Next recebe 4.0.12 apenas pelas mudanças compartilhadas de fixture, documentação,
fallback da fonte e pacote da CLI. Novos projetos Start recebem 5.1.0.

## Validação local

Executada com Node 22.22.1 em cópias e projetos temporários:

| Verificação | Resultado |
| --- | --- |
| Supremo: tipos, lint, cobertura, auditoria estrita e build de produção | Aprovados |
| Suíte do Supremo | 1.874 testes aprovados |
| CLI, incluindo pacote sem geração dinâmica de código | 865 testes aprovados |
| Start público: tipos, lint, cobertura, auditoria e build | Aprovados; 49 testes |
| Start individual: mesmos gates | Aprovados; 66 testes |
| Start multitenant: mesmos gates | Aprovados; 70 testes |
| Navegador: desktop/celular, claro/escuro, cadastro e recuperação de 404 | Aprovado |
| Componentes: foco modal, retorno ao gatilho, menu/abas por teclado e tooltip | Aprovado em produção com CSP |
| SSR, RPC, validação de entrada, CSRF e acesso privado sem sessão | Aprovados; CSRF 403 e RPC privado 401 |
| Segredos sintéticos no bundle público | Nenhuma exposição em quatro marcadores |
| Importação de módulo servidor pelo cliente | Build rejeitado como esperado |
| Preview: HMR, rascunho, rotas, RPC e recuperação de erro de compilação | Processo e porta preservados |
| Diagnóstico local no navegador real | POST 204, mensagem/query omitidas, sem erros CSP |

Na amostra local de três repetições, a atualização de componente teve mediana
de 176 ms; reutilizar o preview saudável teve mediana de 50 ms. São medidas
da fixture nesta máquina, não uma promessa de tempo para criação de apps.

O ensaio de navegador usa valores sintéticos e não acessa um banco Supabase
real. A suíte RLS continua obrigatória na CI; esta validação não é apresentada
como uma nova prova de isolamento em um projeto remoto. A auditoria estrita
não encontrou CRITICAL/HIGH; os 13 avisos MEDIUM existentes continuam visíveis.
