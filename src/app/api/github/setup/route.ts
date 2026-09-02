import { redirect } from 'next/navigation'
import { type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { interpretSetupCallback, listAppInstallations } from '@/lib/github/app'

/**
 * Setup URL da GitHub App (Supremo v3).
 *
 * Depois de instalar/atualizar a App (conta pessoal ou organização, ex.: Hijaziia),
 * o GitHub redireciona para cá com `?installation_id=&setup_action=`. ANTES não
 * existia rota → 404. Agora capturamos a installation, registramos auditoria e
 * voltamos para /accounts com status. A descoberta da installation por conta/org é
 * on-demand (listAppInstallations), então não dependemos de persistir o id aqui.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = new URL(request.url)
  const installationId = searchParams.get('installation_id')
  const setupAction = searchParams.get('setup_action')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const outcome = interpretSetupCallback({
    installationId,
    setupAction,
    hasUser: Boolean(user),
  })

  // Auditoria best-effort (nunca loga token). Resolve a conta/org da installation
  // só para registro legível; a descoberta real continua on-demand no provisioning.
  if (user && installationId) {
    try {
      const all = await listAppInstallations()
      const inst = all.find((i) => String(i.id) === installationId) ?? null
      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action: 'github_app.setup',
        resource_type: 'github_installation',
        metadata: {
          installation_id: installationId,
          setup_action: setupAction,
          account: inst?.accountLogin ?? null,
          account_type: inst?.accountType ?? null,
        },
      })
    } catch {
      // sem App configurada / erro de rede: segue para o redirect (sem 404).
    }
  }

  redirect(outcome.redirect)
}

// evita cache do redirect de setup
export const dynamic = 'force-dynamic'
