import { Cpu, Terminal, Copy, CheckCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { CopyButton } from '@/components/ui/copy-button'

export default async function MCPsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const cwd = process.cwd()
  const mcpCommand = `npm run mcp --prefix ${cwd}`

  const claudeConfig = JSON.stringify({
    mcpServers: {
      supremo: {
        command: "npm",
        args: ["run", "mcp", "--prefix", cwd]
      }
    }
  }, null, 2)

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Cpu className="w-6 h-6 text-primary" />
          Integração MCP (Model Context Protocol)
        </h1>
        <p className="text-muted-foreground mt-1">
          Conecte seus agentes de IA locais (Antigravity, Claude Code, Cursor) para controlarem os projetos gerados pelo Supremo via GitHub API.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Antigravity */}
        <div className="border bg-card rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-orange-500/10 flex items-center justify-center">
              <Terminal className="w-4 h-4 text-orange-500" />
            </div>
            <h2 className="text-lg font-semibold">Antigravity / agy</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Execute o agente Antigravity na sua máquina passando o Supremo como servidor MCP.
          </p>
          <div className="relative group">
            <pre className="bg-secondary p-3 rounded-lg text-sm overflow-x-auto text-secondary-foreground font-mono">
              agy --mcp "{mcpCommand}"
            </pre>
            <CopyButton value={`agy --mcp "${mcpCommand}"`} className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>

        {/* Claude Desktop / Code */}
        <div className="border bg-card rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
              <Cpu className="w-4 h-4 text-purple-500" />
            </div>
            <h2 className="text-lg font-semibold">Claude Desktop</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Adicione esta configuração no seu <code className="bg-secondary px-1 py-0.5 rounded">claude_desktop_config.json</code>:
          </p>
          <div className="relative group">
            <pre className="bg-secondary p-3 rounded-lg text-sm overflow-x-auto text-secondary-foreground font-mono">
              {claudeConfig}
            </pre>
            <CopyButton value={claudeConfig} className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>

        {/* Cursor / Windsurf */}
        <div className="border bg-card rounded-xl p-5 space-y-4 md:col-span-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
              <Cpu className="w-4 h-4 text-blue-500" />
            </div>
            <h2 className="text-lg font-semibold">Cursor / Windsurf / GPT Codex</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Nas configurações do editor, adicione um novo servidor MCP do tipo <strong>stdio</strong> e use o comando abaixo:
          </p>
          <div className="relative group max-w-xl">
            <pre className="bg-secondary p-3 rounded-lg text-sm overflow-x-auto text-secondary-foreground font-mono">
              {mcpCommand}
            </pre>
            <CopyButton value={mcpCommand} className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>
      </div>

      <div className="border rounded-xl bg-primary/5 border-primary/20 p-5 mt-8">
        <h3 className="font-semibold flex items-center gap-2 mb-2 text-primary">
          <CheckCircle className="w-4 h-4" />
          Como as ferramentas funcionam?
        </h3>
        <ul className="text-sm space-y-2 text-muted-foreground list-disc pl-5">
          <li><strong>Sem clone local:</strong> A IA edita os códigos e gerencia arquivos se comunicando diretamente com a API do GitHub através do Supremo.</li>
          <li><strong>Troca de Contexto Automática:</strong> O servidor MCP sempre opera no projeto que estiver marcado como <strong>Ativo</strong> no painel.</li>
          <li>O Supremo cuida de usar as chaves corretas de acordo com a sua conta configurada.</li>
        </ul>
      </div>
    </div>
  )
}
