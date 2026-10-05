# Aceitação local do runtime — 5 de outubro de 2026

Execução concluída no macOS, Node v23.11.0, às 15:43 UTC. Reproduzir com a CLI local já compilada:

```sh
npx tsx scripts/runtime-acceptance.mts
```

O script cria e remove projetos temporários próprios. Compila a CLI 1.13.0 do HEAD anterior, usa o bundle 1.14.0 candidato e confirma o daemon ativo pelo hash do executável. Não instala launchd nem acessa o keychain ou contas reais. Controle remoto e respostas de fornecedor são fixtures HTTP locais; Git, arquivos, processos, journal, sinais e preview HTTP são reais. É um aceite de preservação do processo do preview; não exercita navegação/HMR do Next.js nem provedores externos.

## Resultados

- Projeto anterior: daemon 1.13.0 ativo, preview aberto, checkpoint e operação pendentes. A atualização foi parada com SIGSTOP após substituir o bundle, encerrada com SIGKILL e retomada pelo mesmo ID. Terminou com daemon 1.14.0 confirmado.
- Projeto novo: aplicação e ativação da CLI 1.14.0 confirmadas.
- Nos dois projetos, permaneceram o PID e a porta do preview, HEAD, index, rascunho do app, instruções pessoais, checkpoint e recibo da operação.
- Suspensão/continuação do daemon com SIGSTOP/SIGCONT preservou o preview. Isto não equivale a um ensaio de suspensão real do computador, reboot ou login supervisionado; esses cenários continuam sem prova neste ensaio.
- O teste revelou e corrigiu a identificação do mesmo executável pelos aliases macOS `/var` e `/private/var`. A comparação continua exigindo executável permitido, argumentos exatos, diretório, início do processo e PID.
- A política da release anterior foi preservada antes de atualizar os hashes do lockfile da CLI, mantendo a base 1.13.0 verificável durante o upgrade.

## Tempos do motor local

60 amostras aquecidas, em dois projetos sintéticos; nenhum tempo de modelo, Internet, provedor ou suíte de validação está incluído. A drenagem usa um executor local imediato, não o intervalo de polling do daemon. Não são um SLA.

| Operação | p50 | p95 |
| --- | ---: | ---: |
| Gravar operação durável | 0,77 ms | 1,17 ms |
| Drenar fila com resposta local imediata | 3,64 ms | 5,09 ms |
| Ler recibo persistente | 0,09 ms | 0,19 ms |
| Capturar checkpoint Git | 125,31 ms | 130,05 ms |

A atualização antiga com interrupção/retomada levou 6,39 s; a nova levou 3,22 s. São exemplos únicos, sem percentil estatístico. A espera interativa da fila segue limitada a cinco segundos e devolve um ID durável se a execução ainda estiver pendente.

Comprovante JSON original: `supremo-runtime-acceptance-1791215000842.json`, retornado pelo script no diretório temporário do sistema. O script atual emite duração simples para as amostras únicas de atualização.

Limite preservado: candidatos que exigem trocar dependências do aplicativo permanecem planejados com ID e motivo; não substituem `node_modules` sob um preview ativo. Conflitos locais, autoridade revogada, efeito incerto e downgrade incompatível continuam bloqueando substituições/reenvios, com estado consultável.
