import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { Cpu, Globe, ShieldCheck, GitPullRequest } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Card, CardTitle, CardNote } from '@/components/ui/card'
import { CopyButton } from '@/components/ui/copy-button'
import { TokenManager, type TokenRow } from '@/components/mcps/token-manager'

export const metadata = {
  title: 'Integração MCP — Supremo',
}

/**
 * Resolve a URL pública do MCP a partir do host da requisição.
 *
 * A versão anterior desta página montava o comando com `process.cwd()`, que em
 * produção aponta para o diretório efêmero do lambda. O resultado era uma
 * instrução impossível de executar em qualquer máquina que não fosse a do
 * servidor.
 */
async function resolveMcpUrl(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_APP_URL
  if (configured) return `${configured.replace(/\/$/, '')}/api/mcp`

  const headersList = await headers()
  const host = headersList.get('host') ?? 'localhost:3000'
  const protocol = host.startsWith('localhost') ? 'http' : 'https'
  return `${protocol}://${host}/api/mcp`
}

export default async function MCPsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const mcpUrl = await resolveMcpUrl()

  const { data: tokens } = await supabase
    .from('mcp_tokens')
    .select('id, name, token_prefix, last_used_at, expires_at, created_at')
    .eq('user_id', user.id)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })

  const claudeCodeCommand = `claude mcp add --transport http supremo ${mcpUrl} --header"Authorization: Bearer SEU_TOKEN"`

  const jsonConfig = JSON.stringify(
    {
      mcpServers: {
        supremo: {
          type: 'http',
          url: mcpUrl,
          headers: { Authorization: 'Bearer SEU_TOKEN' },
        },
      },
    },
    null,
    2,
  )

  const bridgeConfig = JSON.stringify(
    {
      mcpServers: {
        supremo: {
          command: 'npx',
          args: ['-y', '@supremo/cli', 'mcp'],
          env: { SUPREMO_URL: mcpUrl, SUPREMO_TOKEN: 'SEU_TOKEN' },
        },
      },
    },
    null,
    2,
  )

  return (
    <div className="space-y-3 sm:space-y-4">
      <Card>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Cpu className="text-ink h-6 w-6" />
          Integração MCP
        </h1>
        <p className="text-muted mt-1.5">
          Conecte qualquer agente — Claude Code, Antigravity, Codex, Cursor — de
          qualquer computador. Nada é instalado localmente: o agente fala HTTP
          com o Supremo, e o Supremo é o único que toca o seu GitHub e o seu
          Supabase.
        </p>
      </Card>

      {/* Endpoint */}
      <Card className="space-y-3">
        <div className="flex items-center gap-2">
          <Globe className="text-ink h-4 w-4" />
          <h2 className="font-semibold">Seu endpoint</h2>
        </div>
        <div className="relative">
          <pre className="bg-sunken text-ink overflow-x-auto rounded-[var(--radius-control)] p-3 pr-12 font-mono text-sm">
            {mcpUrl}
          </pre>
          <CopyButton value={mcpUrl} className="absolute top-2.5 right-2.5" />
        </div>
        <p className="text-muted text-sm">
          O mesmo endereço funciona de qualquer lugar. O que separa as suas
          contas é o token, não a máquina.
        </p>
      </Card>

      {/* Tokens */}
      <Card className="space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="text-ink h-4 w-4" />
          <h2 className="font-semibold">Tokens de acesso</h2>
        </div>
        <p className="text-muted text-sm">
          Um token por máquina facilita revogar o acesso de um computador sem
          derrubar os outros.
        </p>
        <TokenManager tokens={(tokens ?? []) as TokenRow[]} mcpUrl={mcpUrl} />
      </Card>

      {/* Clientes */}
      <Card className="space-y-4">
        <h2 className="font-semibold">Como conectar</h2>

        <div className="bg-surface space-y-3 rounded-[var(--radius-inner)] p-5">
          <h3 className="text-sm font-semibold">Claude Code</h3>
          <div className="relative">
            <pre className="bg-sunken text-ink overflow-x-auto rounded-[var(--radius-control)] p-3 pr-12 font-mono text-xs">
              {claudeCodeCommand}
            </pre>
            <CopyButton
              value={claudeCodeCommand}
              className="absolute top-2.5 right-2.5"
            />
          </div>
        </div>

        <div className="bg-surface space-y-3 rounded-[var(--radius-inner)] p-5">
          <h3 className="text-sm font-semibold">
            Cursor · Windsurf · Claude Desktop · Codex
          </h3>
          <p className="text-muted text-sm">
            Clientes com suporte a MCP remoto aceitam a configuração direta:
          </p>
          <div className="relative">
            <pre className="bg-sunken text-ink overflow-x-auto rounded-[var(--radius-control)] p-3 pr-12 font-mono text-xs">
              {jsonConfig}
            </pre>
            <CopyButton
              value={jsonConfig}
              className="absolute top-2.5 right-2.5"
            />
          </div>
        </div>

        <div className="bg-surface space-y-3 rounded-[var(--radius-inner)] p-5">
          <h3 className="text-sm font-semibold">
            Cliente sem suporte a MCP remoto
          </h3>
          <p className="text-muted text-sm">
            A ponte roda via{' '}
            <code className="bg-sunken rounded px-1 py-0.5">npx</code>, sem
            instalação permanente. Ela só repassa as chamadas para o endpoint
            acima — nenhum segredo mora nela.
          </p>
          <div className="relative">
            <pre className="bg-sunken text-ink overflow-x-auto rounded-[var(--radius-control)] p-3 pr-12 font-mono text-xs">
              {bridgeConfig}
            </pre>
            <CopyButton
              value={bridgeConfig}
              className="absolute top-2.5 right-2.5"
            />
          </div>
        </div>
      </Card>

      {/* Como funciona */}
      <Card className="bg-sunken space-y-3 rounded-[var(--radius-inner)] p-5">
        <div className="text-ink flex items-center gap-2">
          <GitPullRequest className="h-4 w-4" />
          <h2 className="font-semibold">
            O que o agente pode e não pode fazer
          </h2>
        </div>
        <ul className="text-muted space-y-2 text-sm">
          <li>
            <strong className="text-ink">
              As regras viajam com o projeto.
            </strong>{' '}
            <code className="bg-sunken rounded px-1 py-0.5 text-xs">
              get_project_context
            </code>{' '}
            devolve o agents.md, o CLAUDE.md e o SECURITY.md lidos do seu
            repositório. O agente segue as regras sem clonar nada.
          </li>
          <li>
            <strong className="text-ink">
              Não existe commit direto na main.
            </strong>{' '}
            A única ferramenta de escrita cria branch e abre pull request.
          </li>
          <li>
            <strong className="text-ink">O gate é real.</strong>{' '}
            <code className="bg-sunken rounded px-1 py-0.5 text-xs">
              wait_for_checks
            </code>{' '}
            espera o CI de verdade, e{' '}
            <code className="bg-sunken rounded px-1 py-0.5 text-xs">
              merge_when_green
            </code>{' '}
            recusa se algum check estiver vermelho.
          </li>
          <li>
            <strong className="text-ink">Migration sem RLS é recusada.</strong>{' '}
            Tabela nova sem{' '}
            <code className="bg-sunken rounded px-1 py-0.5 text-xs">
              ENABLE ROW LEVEL SECURITY
            </code>{' '}
            não passa pelo servidor.
          </li>
        </ul>
      </Card>
    </div>
  )
}
