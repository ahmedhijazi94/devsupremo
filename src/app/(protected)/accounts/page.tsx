import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Database } from 'lucide-react'
import { formatRelativeTime } from '@/lib/utils'
import { ConnectGithubButton } from '@/components/accounts/connect-github-button'
import { AddSupabaseModal } from '@/components/accounts/add-supabase-modal'
import { ConnectVercelModal } from '@/components/accounts/connect-vercel-modal'
import { isVercelOAuthAvailable } from '@/actions/vercel'
import { DisconnectVercelButton } from '@/components/accounts/disconnect-vercel-button'
import { DisconnectAccountButton } from '@/components/accounts/disconnect-account-button'
import { AccountsToastHandler } from '@/components/accounts/accounts-toast-handler'

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>
}) {
  const supabase = await createClient()
  const { success, error: errorParam } = await searchParams

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [githubResponse, supabaseResponse, vercelResponse] = await Promise.all([
    supabase.from('github_accounts').select('*').eq('user_id', user.id).order('created_at', { ascending: false }),
    supabase.from('supabase_accounts').select('*').eq('user_id', user.id).order('created_at', { ascending: false }),
    supabase.from('vercel_accounts').select('*').eq('user_id', user.id).order('created_at', { ascending: false }),
  ])

  const githubAccounts = githubResponse.data ?? []
  const supabaseAccounts = supabaseResponse.data ?? []
  const vercelAccounts = vercelResponse.data ?? []
  const vercelOAuth = await isVercelOAuthAvailable()

  return (
    <div className="space-y-8 max-w-4xl">
      {/* Toast handler para mensagens de redirect */}
      <AccountsToastHandler success={success} error={errorParam} />

      <div>
        <h1 className="text-2xl font-bold">Contas Conectadas</h1>
        <p className="text-muted-foreground mt-1">
          Gerencie as contas que os MCPs do Supremo usam para criar e modificar projetos.
        </p>
      </div>

      {/* GitHub Accounts */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-foreground/5 border flex items-center justify-center">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-semibold">GitHub</h2>
              <p className="text-xs text-muted-foreground">Para criar e gerenciar repositórios</p>
            </div>
          </div>
          <ConnectGithubButton />
        </div>

        {githubAccounts.length === 0 ? (
          <div className="rounded-xl border border-dashed p-10 text-center space-y-2">
            <p className="text-sm font-medium">Nenhuma conta GitHub conectada</p>
            <p className="text-xs text-muted-foreground max-w-xs mx-auto">
              O Supremo não poderá criar ou modificar repositórios até você conectar uma conta.
            </p>
          </div>
        ) : (
          <div className="grid gap-3">
            {githubAccounts.map((acc) => (
              <div key={acc.id} className="flex items-center justify-between p-4 rounded-xl border bg-card">
                <div className="flex items-center gap-3">
                  {acc.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={acc.avatar_url} alt="" className="w-10 h-10 rounded-full" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-secondary" />
                  )}
                  <div>
                    <p className="font-medium text-sm">
                      {acc.login}
                      {acc.name ? <span className="text-muted-foreground font-normal ml-1">({acc.name})</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Conectado {formatRelativeTime(acc.created_at)} · escopos: {acc.scopes?.join(', ') || 'repo'}
                    </p>
                  </div>
                </div>
                <DisconnectAccountButton type="github" accountId={acc.id} />
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="border-t" />

      {/* Supabase Accounts */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[#3ECF8E]/10 border border-[#3ECF8E]/20 flex items-center justify-center">
              <Database className="w-5 h-5 text-[#3ECF8E]" />
            </div>
            <div>
              <h2 className="text-base font-semibold">Supabase</h2>
              <p className="text-xs text-muted-foreground">Para provisionar bancos e aplicar migrations</p>
            </div>
          </div>
          <AddSupabaseModal />
        </div>

        {supabaseAccounts.length === 0 ? (
          <div className="rounded-xl border border-dashed p-10 text-center space-y-2">
            <p className="text-sm font-medium">Nenhuma conta Supabase conectada</p>
            <p className="text-xs text-muted-foreground max-w-xs mx-auto">
              O Supremo não poderá provisionar bancos de dados automáticamente sem um Access Token.
            </p>
          </div>
        ) : (
          <div className="grid gap-3">
            {supabaseAccounts.map((acc) => (
              <div key={acc.id} className="flex items-center justify-between p-4 rounded-xl border bg-card">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-[#3ECF8E]/10 border border-[#3ECF8E]/20 flex items-center justify-center">
                    <Database className="w-5 h-5 text-[#3ECF8E]" />
                  </div>
                  <div>
                    <p className="font-medium text-sm">{acc.org_name}</p>
                    <p className="text-xs text-muted-foreground">
                      Adicionado {formatRelativeTime(acc.created_at)}
                    </p>
                  </div>
                </div>
                <DisconnectAccountButton type="supabase" accountId={acc.id} />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Vercel */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-foreground/5 border flex items-center justify-center">
              <svg className="w-4 h-4" viewBox="0 0 76 65" fill="currentColor" aria-hidden>
                <path d="M37.59.25l36.95 64H.64l36.95-64z" />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-semibold">Vercel</h2>
              <p className="text-xs text-muted-foreground">
                Para publicar o preview de cada mudança
              </p>
            </div>
          </div>
          <ConnectVercelModal oauthAvailable={vercelOAuth} />
        </div>

        {vercelAccounts.length === 0 ? (
          <div className="rounded-xl border border-dashed p-10 text-center space-y-2">
            <p className="text-sm font-medium">Nenhuma conta Vercel conectada</p>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              Sem ela os projetos ficam sem preview publicado — você continua
              vendo o código, mas não tem link para abrir o app nem para mandar
              para outra pessoa.
            </p>
          </div>
        ) : (
          <div className="grid gap-3">
            {vercelAccounts.map((acc) => (
              <div key={acc.id} className="flex items-center justify-between p-4 rounded-xl border bg-card">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-foreground/5 border flex items-center justify-center">
                    <svg className="w-4 h-4" viewBox="0 0 76 65" fill="currentColor" aria-hidden>
                      <path d="M37.59.25l36.95 64H.64l36.95-64z" />
                    </svg>
                  </div>
                  <div>
                    <p className="font-medium text-sm">{acc.account_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {acc.team_id ? 'Time' : 'Conta pessoal'} · conectada{' '}
                      {formatRelativeTime(acc.created_at)}
                    </p>
                  </div>
                </div>
                <DisconnectVercelButton accountId={acc.id} />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
