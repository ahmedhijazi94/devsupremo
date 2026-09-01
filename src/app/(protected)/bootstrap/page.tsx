import { BootstrapAuthorize } from '@/components/projects/bootstrap-authorize'

/**
 * Página de autorização do bootstrap (device flow). O dev roda `supremo bootstrap
 * <project-id>` no terminal; o CLI abre esta página com o user_code. Aqui, já
 * autenticado, o DONO confirma que aquela máquina pode receber a config.
 */
export default async function BootstrapPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>
}) {
  const { code } = await searchParams
  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 px-6 py-12">
      <div>
        <h1 className="text-ink text-xl font-semibold">Autorizar máquina local</h1>
        <p className="text-muted mt-1 text-sm">
          Confirme o código mostrado no seu terminal para liberar a configuração
          do projeto nesta máquina.
        </p>
      </div>
      <BootstrapAuthorize initialCode={code ?? ''} />
    </div>
  )
}
