# E2E v4-9 — envio local parado

## Evidência de 13/09/2026

- Scaffold 4.0.8 / CLI 1.7.7.
- Primeiro checkpoint falhou em tipos. O pedido seguinte para usar tons de azul
  corrigiu os erros. Tipos, lint, testes e browser passaram; RLS ficou corretamente
  delegado ao CI. Ambos os checkpoints tinham títulos descritivos na fila local.
- O segundo checkpoint permaneceu local, sem tentativa de envio. O daemon estava
  vivo e os workers independentes mantinham atividade, mas a fila não avançava.
- Uma reprodução em diretório temporário, lendo os mesmos objetos Git e uma cópia
  da fila/evidências sem rede ou credenciais, iniciou a revalidação com a base
  anterior ao primeiro checkpoint falho, como esperado.
- Reiniciar somente o daemon pelos comandos oficiais stop/ensure fez a fila avançar:
  revalidação completa e publicação do segundo checkpoint na PR #1 confirmada no
  journal local. Preview e código do app não foram alterados nesta intervenção.

## Diagnóstico

O transporte de publicação não tinha prazo: uma resposta parada, inclusive após
os headers, impedia o loop de retornar e aplicar o backoff. Workers independentes
continuavam ativos. Além disso, a resposta de uma tentativa podia reaplicar um
snapshot antigo de validação por cima de um diagnóstico mais novo. São caminhos
reproduzidos por testes; o log do incidente original não permite provar qual
operação estava parada naquele momento.

A aprovação remota e a integração desta revisão ainda não foram verificadas no
momento deste registro. A validação de RLS não foi dispensada.

## Correção do motor — CLI 1.7.8 / scaffold 4.0.9

- Publicação limitada a 360 segundos, incluindo leitura do corpo. O endpoint
  fixa sua duração máxima em 300 segundos na Vercel, deixando margem antes de
  uma nova tentativa. Cancelamento de cliente não implica cancelar o servidor.
- Prazo vencido encerra a requisição local e devolve o checkpoint à fila com
  backoff. O loop retenta sozinho, mantendo ID, SHA e hash do conteúdo.
- Só uma resposta com número de PR válido confirma o envio. Timeout, resposta
  incompleta ou inválida não inventam publicação nem aprovação dos testes.
- O resultado altera apenas os campos de transporte do registro mais recente;
  não sobrescreve a evidência/validação que terminou durante a espera.
- Saúde do envio tem fase, prazo e contagem de recuperações próprios, separados
  dos heartbeats de banco/validação. Espera por validação e backoff são estados
  legítimos. Não se cria outro daemon nem se mata processo por idade da fila.
- Não há edição do aplicativo, do banco, do preview ou das suas credenciais.
  As políticas publicadas em 4.0.8 foram preservadas para compatibilidade.

## Provas automatizadas

Servidor HTTP real com headers ausentes ou JSON interrompido; reenvio do mesmo
conteúdo após aborto; rejeição de ACK inválido; diagnóstico atualizado durante
o envio; saúde vencida apesar de worker vivo; espera/backoff saudáveis; ciclo
real do daemon que publica após timeout sem novo comando. Nesse ciclo, HEAD,
arquivo do app e ambiente permanecem idênticos. As suítes existentes também
cobrem revalidação da base após checkpoint falho e preservação do preview.

Esta correção passa a valer quando a CLI 1.7.8 está em execução. Publicar o
motor não substitui o binário nem o processo já instalado em projetos antigos.
