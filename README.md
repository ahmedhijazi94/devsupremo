# Supremo

Plataforma para criar e evoluir aplicações com agentes de IA — de qualquer
máquina, com o repositório e o banco na sua própria conta.

A diferença para as ferramentas de "app por prompt": aqui **nenhuma mudança
entra na branch principal sem passar pelos gates**. O agente propõe em branch,
abre pull request, espera o CI de verdade, lê o log quando falha, e só faz
merge com tudo verde.

## Como funciona

```
agente (qualquer máquina)  →  MCP remoto  →  seu GitHub + seu Supabase
       ↑                                              ↓
       └────────── log da falha ← gates do CI ────────┘
```

O agente nunca recebe as suas credenciais. Ele fala com o Supremo por HTTP
autenticado com um token pessoal; o Supremo é o único que toca os provedores,
e toda consulta é filtrada pelo dono do token.

## Conectando um agente

Gere um token em `/mcps` e rode, em qualquer computador:

```bash
claude mcp add --transport http supremo https://SEU_APP/api/mcp --header "Authorization: Bearer sup_..."
```

Clientes sem suporte a MCP remoto usam a ponte:

```bash
npx -y supremo-cli connect --token sup_...
```

Nada é instalado de forma permanente e nenhum segredo fica na máquina além do
próprio token, que é revogável a qualquer momento.

## As regras viajam com o projeto

`get_project_context` lê `agents.md`, `CLAUDE.md` e `SECURITY.md` do seu
repositório e devolve ao agente, junto com o estado do branch. O servidor
também declara as regras invioláveis no handshake do MCP. O agente segue o
projeto sem precisar de clone local.

## Ferramentas expostas

| Ferramenta | O que faz |
| --- | --- |
| `get_project_context` | Projeto ativo, regras do repositório e estado do branch |
| `list_projects` · `switch_project` | Navegação entre projetos |
| `read_file` · `list_files` | Leitura do repositório |
| `propose_changes` | Branch + commit + pull request. Único caminho de escrita |
| `get_checks` · `wait_for_checks` | Estado dos gates; a espera é real |
| `get_failed_logs` | Saída dos jobs que falharam |
| `merge_when_green` | Squash merge, recusado se algum gate estiver vermelho |
| `execute_sql` | Consulta de leitura no banco do projeto |
| `apply_migration` | Versiona a migration e aplica; recusa tabela sem RLS |

## O que um projeto gerado recebe

Next.js 16, React 19, TypeScript strict, Tailwind v4, Supabase com RLS. Além
do código:

- **Testes de política RLS por tabela** — provam que outro usuário não lê,
  atualiza nem apaga a linha. É a falha número um de app Supabase, coberta
  automaticamente.
- CI com tipos, lint, cobertura com threshold que reprova, auditoria de
  segurança, CodeQL, gitleaks, `npm audit` e E2E.
- CSP e cabeçalhos de segurança verificados por teste E2E.
- Migrations versionadas no repositório.
- Proteção de branch aplicada no provisionamento.

O template é validado no CI do próprio Supremo: um projeto é gerado a cada
build e os gates dele rodam de verdade.

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

Aplique em ordem no seu Supabase:

- `supabase/migrations/001_initial_schema.sql`
- `supabase/migrations/002_mcp_tokens_and_loop.sql`

## Variáveis de ambiente

Veja `.env.example`. `ENCRYPTION_KEY` precisa ser 64 caracteres hex:

```bash
openssl rand -hex 32
```

Ela cifra os tokens de GitHub e Supabase em AES-256-GCM. Perder essa chave
significa perder o acesso às contas conectadas.
