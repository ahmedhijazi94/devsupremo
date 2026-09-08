# Zod na CLI e os alertas específicos de sanitização

A análise de 8 de setembro de 2026 do PR #58 apontou `js/bad-code-sanitization` em `Doc.compile`, parte do Zod 4.5.2 incorporado em `packages/cli/dist/bin.js`. Os alertas 13 e 57 correspondiam às duas cópias da mesma dependência, resolvidas a partir da CLI e das políticas compartilhadas do repositório.

## Correção aplicada

A primeira importação da CLI configura `z.config({ jitless: true })`, antes de construir schemas. Esse é o modo oficialmente suportado pelo Zod para ambientes sem `eval`: objetos usam seu parser interpretado e a biblioteca não faz a sondagem de `Function`. O build resolve os imports `zod` para a mesma instalação da CLI, mantendo o executável independente de `node_modules` em runtime e evitando duas cópias/configurações na distribuição.

Não há patch no código de terceiros, reimplementação de validação, exclusão de arquivos do CodeQL ou supressão da regra. A CLI não usa `z.compile()` nem importa `zod/compile`, que são formas explícitas de optar por geração de código e não devem ser introduzidas neste executável.

## Evidência reproduzível

`npm --prefix packages/cli test -- --run src/zod-jitless.test.ts` constrói o executável real em uma pasta temporária e verifica:

- Uma única cópia do Zod no mapa de módulos do bundle.
- Execução de versão, ajuda, consulta de política e alteração local tipada com `--disallow-code-generation-from-strings`.
- Um preload anterior ao executável conta tentativas de construir/chamar `Function`, incluindo sondagens que o Zod poderia capturar: nenhuma ocorre.
- Chaves e valores contendo fechamento de `<script>`, aspas, texto semelhante a comandos e separadores Unicode permanecem dados; inputs inválidos continuam recusados.
- Regras compartilhadas de jobs e pedidos de secrets continuam recusando SQL extra, atualização de permissões e envio de valores secretos.
- O executável funciona sem dependências instaladas ao seu lado.

O teste de processo, o typecheck da CLI e o lint focal passaram após a alteração. O teste gera somente arquivos temporários e não acessa serviços ou projetos de usuários.

## Limite e interpretação do alerta

A configuração oficial desativa o caminho de execução, mas o bundle ainda pode conter funções de compilação exportadas pelo Zod. Isso é diferente de afirmar que o scanner deixará de apontá-las. A regra deve continuar ativa.

O exemplo de risco descrito por `js/bad-code-sanitization` é a inserção de JavaScript construído com `JSON.stringify` em HTML: uma chave contendo `</script>` pode sair do elemento. O trecho analisado aqui pertence a um executável Node; a função gerada não é inserida em HTML. No fast path upstream, as chaves de schema usam `JSON.stringify` e os valores dos dados são argumentos ou variáveis fechadas pela função, não fragmentos interpolados de código. Além disso, a CLI agora permanece no parser interpretado, como comprovado antes mesmo de sua inicialização.

Isso fornece fundamento para avaliar **estes alertas específicos** no contexto da dependência upstream. Não classifica indiscriminadamente alertas de sanitização como falsos positivos e não altera seu estado no GitHub. Qualquer alerta restante deve ser revisado novamente no SHA efetivamente publicado.

Referências oficiais:

- [Zod: compilação e Content Security Policy](https://zod.dev/compile#content-security-policy).
- [Zod: orientação do mantenedor para configurar jitless antes dos schemas](https://github.com/colinhacks/zod/issues/4461).
- [Código upstream do Zod](https://github.com/colinhacks/zod), comparado à versão 4.5.2 instalada e travada nos lockfiles deste repositório.
