# Runtime local

O agente edita o projeto diretamente. A CLI faz bootstrap e autenticação do
dispositivo; o harness gerado mantém o preview local e fornece diagnóstico.

O checkpoint salva um commit local e acrescenta um evento à fila JSONL. O
daemon publica em background nas APIs de checkpoint. Atualizações da fila
são eventos adicionais: não reescrevem um snapshot que poderia perder um
checkpoint criado durante uma requisição. A leitura usa o último estado de
cada ID e preserva a ordem original.

O servidor valida dispositivo, grant, dono e projeto antes de integrar via
GitHub. CI e merge continuam assíncronos. Não há dependência de um CI verde
para o agente começar a próxima edição ou para manter o preview saudável.

O transporte MCP e o companion v1 foram removidos. O cliente GitHub e o
repositório de projetos foram preservados em módulos próprios porque servem
a integração atual. Migrations históricas permanecem intactas.

Banco de desenvolvimento deve ser independente de produção. As regras do
template orientam essa separação; não criam nem migram ambientes existentes
automaticamente.
