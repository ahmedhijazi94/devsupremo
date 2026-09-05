/** Management API can acknowledge configuration before Auth has reloaded it. */
export async function waitForAnonymousAuth(
  read: () => Promise<boolean>,
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 1000)),
): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt++) {
    if (await read()) return
    if (attempt < 14) await pause()
  }
  throw new Error('Anonymous Auth ainda não está disponível no serviço de login. Tente novamente; nenhum fallback local foi utilizado.')
}
