'use client'

import { useState } from 'react'
import { Terminal, FileJson, Rocket, MessageSquare } from 'lucide-react'
import { CopyButton } from '@/components/ui/copy-button'
import { cn } from '@/lib/utils'

/**
 * Gerador de conexão por agente.
 *
 * A tela antiga listava um comando com bug (--header sem espaço, que não roda)
 * e uma ponte apontando para um pacote inexistente. Aqui o snippet é montado
 * do jeito certo, com o token já dentro quando ele acabou de ser gerado, e
 * cada agente traz onde colar e como começar.
 *
 * O "primeiro prompt" é de propósito: ele manda o agente ler o contexto e
 * seguir as regras antes de escrever código. É o que garante que o tempo do
 * usuário vá para a funcionalidade, não para consertar o que o agente fez
 * fora da linha.
 */

interface Agent {
  id: string
  label: string
  kind: 'shell' | 'json' | 'toml'
  /** Onde o snippet vai. */
  where: string
  build: (url: string, token: string) => string
  start: string
}

const remoteJson = (url: string, token: string) =>
  JSON.stringify(
    {
      mcpServers: {
        supremo: {
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  )

const mcpRemoteJson = (url: string, token: string) =>
  JSON.stringify(
    {
      mcpServers: {
        supremo: {
          command: 'npx',
          args: [
            '-y',
            'mcp-remote',
            url,
            '--header',
            `Authorization: Bearer ${token}`,
          ],
        },
      },
    },
    null,
    2,
  )

const AGENTS: Agent[] = [
  {
    id: 'claude',
    label: 'Claude (app)',
    kind: 'json',
    where:
      'No app do Claude: Configurações › Desenvolvedor › Editar config, ou o arquivo claude_desktop_config.json. Cole e reinicie o Claude. NÃO use um CLI local — é a ponte mcp-remote oficial que injeta o token.',
    build: mcpRemoteJson,
    start:
      'Reinicie o Claude. O "supremo" aparece nas ferramentas e traz get_project_context, apply_migration, etc.',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    kind: 'shell',
    where: 'Rode este comando na pasta do seu projeto (uma vez).',
    build: (url, token) =>
      `claude mcp add --transport http supremo ${url} --header "Authorization: Bearer ${token}"`,
    start: 'Depois é só pedir a alteração no chat do Claude Code.',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'json',
    where:
      'Cole em .cursor/mcp.json (no projeto) ou ~/.cursor/mcp.json (global).',
    build: remoteJson,
    start:
      'Reinicie o Cursor. Em Settings › MCP o "supremo" aparece. Peça a feature no chat.',
  },
  {
    id: 'codex',
    label: 'Codex',
    kind: 'toml',
    where: 'Cole em ~/.codex/config.toml.',
    build: (url, token) =>
      `[mcp_servers.supremo]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "${url}", "--header", "Authorization: Bearer ${token}"]`,
    start: 'Rode o codex de novo. O Supremo entra como ferramenta.',
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    kind: 'json',
    where: 'Cole na configuração de MCP do Antigravity e recarregue.',
    build: remoteJson,
    start: 'Salve, recarregue, e peça a primeira feature.',
  },
  {
    id: 'outro',
    label: 'Outro',
    kind: 'json',
    where:
      'Qualquer cliente com MCP remoto (Windsurf, Zed…). A ponte mcp-remote vale quando o cliente só aceita stdio.',
    build: mcpRemoteJson,
    start: 'Reinicie o cliente. O Supremo aparece como servidor MCP.',
  },
]

const FIRST_PROMPT =
  'Você está conectado ao Supremo. Antes de escrever qualquer código, chame ' +
  'get_project_context para ler as regras do projeto (agents.md, CLAUDE.md, ' +
  'SECURITY.md) e ver se há trabalho em andamento para retomar. Siga essas ' +
  'regras à risca: estrutura limpa, RLS em toda tabela, nada de segredo no ' +
  'código, validação sempre no servidor. Abra a mudança por pull request e ' +
  'só finalize quando todos os gates estiverem verdes. Agora implemente: '

const ICON = { shell: Terminal, json: FileJson, toml: FileJson } as const

export function ConnectionGenerator({
  mcpUrl,
  token,
}: {
  mcpUrl: string
  token?: string | null
}) {
  const [active, setActive] = useState(AGENTS[0]!.id)
  const agent = AGENTS.find((a) => a.id === active) ?? AGENTS[0]!
  const value = token ?? 'SEU_TOKEN'
  const snippet = agent.build(mcpUrl, value)
  const Icon = ICON[agent.kind]

  // Preview local: o companion precisa da URL base do Supremo (sem /api/mcp).
  // É UM arquivo só (bundle standalone) — baixa e roda, sem clonar o repo.
  const baseUrl = mcpUrl.replace(/\/api\/mcp\/?$/, '')
  const companionSnippet =
    `curl -fsSL ${baseUrl}/companion/supremo-runtime.mjs -o supremo-runtime.mjs\n` +
    `node supremo-runtime.mjs login --url ${baseUrl} --token ${value}\n` +
    `node supremo-runtime.mjs run`

  return (
    <div className="space-y-4">
      {!token && (
        <p className="text-muted text-xs">
          Gere um token acima e o comando já vem com ele preenchido. Sem token,
          troque{' '}
          <code className="bg-sunken rounded px-1 py-0.5">SEU_TOKEN</code> pelo
          valor gerado.
        </p>
      )}

      {/* Abas de agente */}
      <div className="flex flex-wrap gap-1.5">
        {AGENTS.map((a) => {
          const on = a.id === active
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => setActive(a.id)}
              aria-pressed={on}
              className={cn(
                'rounded-[var(--radius-control)] px-3 py-1.5 text-sm font-medium transition-colors',
                on
                  ? 'bg-accent text-accent-ink'
                  : 'bg-sunken text-muted hover:text-ink',
              )}
            >
              {a.label}
            </button>
          )
        })}
      </div>

      {/* Onde colar */}
      <div className="text-muted flex items-start gap-2 text-sm">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{agent.where}</span>
      </div>

      {/* O snippet */}
      <div className="relative">
        <pre className="bg-sunken text-ink overflow-x-auto rounded-[var(--radius-control)] p-3 pr-12 font-mono text-xs whitespace-pre">
          {snippet}
        </pre>
        <CopyButton value={snippet} className="absolute top-2.5 right-2.5" />
      </div>

      {/* Como iniciar */}
      <div className="bg-sunken flex items-start gap-2 rounded-[var(--radius-control)] p-3">
        <Rocket className="text-ink mt-0.5 h-4 w-4 shrink-0" />
        <p className="text-muted text-sm">
          <strong className="text-ink">Conectou?</strong> {agent.start}
        </p>
      </div>

      {/* Primeiro prompt — já manda o agente seguir as regras */}
      <div className="space-y-2">
        <div className="text-ink flex items-center gap-2">
          <MessageSquare className="h-4 w-4" />
          <h4 className="text-sm font-semibold">
            Cole isto como primeira mensagem
          </h4>
        </div>
        <p className="text-muted text-xs">
          Faz o agente ler as regras e usar o fluxo com gates. Depois é só
          descrever a feature — seu tempo vai para o que o app faz, não para
          consertar segurança.
        </p>
        <div className="relative">
          <pre className="bg-sunken text-ink overflow-x-auto rounded-[var(--radius-control)] p-3 pr-12 text-xs whitespace-pre-wrap">
            {FIRST_PROMPT}
            <span className="text-muted">[descreva a funcionalidade aqui]</span>
          </pre>
          <CopyButton
            value={FIRST_PROMPT + '[descreva a funcionalidade aqui]'}
            className="absolute top-2.5 right-2.5"
          />
        </div>
      </div>

      {/* Preview local — o companion na máquina do dev, com o token já preenchido */}
      <div className="space-y-2">
        <div className="text-ink flex items-center gap-2">
          <Rocket className="h-4 w-4" />
          <h4 className="text-sm font-semibold">Preview local (companion)</h4>
        </div>
        <p className="text-muted text-xs">
          Roda o Next real na sua máquina, com HMR. Cole no Terminal em QUALQUER
          pasta — é um arquivo só, não precisa clonar nada. Baixa, salva o login
          (token e URL já preenchidos) e mantém o companion rodando.
        </p>
        <div className="relative">
          <pre className="bg-sunken text-ink overflow-x-auto rounded-[var(--radius-control)] p-3 pr-12 font-mono text-xs whitespace-pre">
            {companionSnippet}
          </pre>
          <CopyButton
            value={companionSnippet}
            className="absolute top-2.5 right-2.5"
          />
        </div>
      </div>
    </div>
  )
}
