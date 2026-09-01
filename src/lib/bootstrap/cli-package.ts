/**
 * Nome CANÔNICO do package npm oficial do CLI do Supremo.
 *
 * Fonte única: o comando de bootstrap gerado pelo Supremo, o package publicado
 * (`packages/cli/package.json`) e os testes referenciam ESTE valor. Assim o
 * comando nunca aponta para um package inexistente (o bug do `@supremo/cli`, que
 * nunca foi publicado). Um teste garante que `packages/cli/package.json` tem
 * exatamente este `name`.
 *
 * `supremo-cli` é um nome não-scoped, publicável sem criar uma org npm. Se um dia
 * migrar para um scope próprio (ex.: `@org/cli`), troque AQUI e no package.json —
 * o teste falha se divergirem.
 */
export const CLI_PACKAGE = 'supremo-cli'
