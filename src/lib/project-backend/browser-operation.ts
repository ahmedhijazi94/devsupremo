/** Store only a digest and ID in this tab; never persist the operation payload.
 * Keeping the ID through navigation permits an exact approval to be resumed and
 * prevents a lost response from turning a second click into a duplicate write. */
export async function browserOperation(projectId: string, input: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)))
  const key = `supremo-operation:${projectId}:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
  const previous = sessionStorage.getItem(key)
  const id = previous && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(previous) ? previous : crypto.randomUUID()
  sessionStorage.setItem(key, id)
  return { id, confirmed: () => { if (sessionStorage.getItem(key) === id) sessionStorage.removeItem(key) } }
}
