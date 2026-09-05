# Supremo

Supremo estrutura apps para desenvolver diretamente no agente que você já usa,
com código no seu GitHub e banco na sua conta Supabase.

## Como funciona

1. Crie um projeto no Supremo e execute o comando de bootstrap exibido.
2. Abra a pasta no seu agente e descreva o que quer construir.
3. O projeto fornece regras, scripts e preview local persistente.
4. Checkpoints são salvos localmente e enviados pelo daemon em background.
5. CI verifica a integração sem bloquear a próxima alteração no desenvolvimento.

O transporte MCP v1 e seu companion foram removidos. A CLI atual usa
bootstrap, checkpoint, daemon e sync. O supervisor do preview local permanece.

## O que o projeto recebe

Next.js, TypeScript, Supabase, migrations, regras de arquitetura e segurança,
testes de isolamento RLS e verificações automatizadas. Essas verificações
cobrem riscos conhecidos; segurança e capacidade de escala também dependem
da implementação de cada app e de testes com sua carga real.

Use banco local ou exclusivo de desenvolvimento. A promoção de migrations
para produção é separada do ciclo rápido de edição e preview.

## Desenvolvimento

```bash
npm install
cp .env.example .env.local
npm run dev
```

| Comando | O que faz |
| --- | --- |
| `npm run typecheck` | TypeScript, zero erros |
| `npm run lint` | ESLint, zero erros |
| `npm test` | Testes unitários |
| `npm run test:coverage` | Cobertura, mínimo 85% |
| `npm run audit:security` | Auditoria estática (`--strict` reprova) |
| `npm run build` | Build de produção |

Gerar um projeto do template localmente para inspeção:

```bash
npx tsx scripts/dev/generate-sample-project.ts /tmp/exemplo
```

## Migrations

Aplique as migrations versionadas em `supabase/migrations/` na ordem.
Arquivos históricos permanecem para compatibilidade com bancos existentes.
A limpeza do código legado não apaga tabelas nem dados remotos.

## Variáveis de ambiente

Veja `.env.example`. `ENCRYPTION_KEY` precisa ser 64 caracteres hex:

```bash
openssl rand -hex 32
```

Ela cifra os tokens de GitHub e Supabase em AES-256-GCM. Perder essa chave
significa perder o acesso às contas conectadas.
