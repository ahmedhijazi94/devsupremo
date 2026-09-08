import { assertSameBinding, secretEntrySchema, secretRequestView, SecretRequestError, type SecretBinding, type SecretEntry, type SecretRequestRecord, type SecretRequestView } from './policy'

/** Ports never persist the submitted value. Only deliver receives it. */
export interface SecretRequestPort {
  authorize(): Promise<void>
  resolve(entry: Pick<SecretEntry, 'target' | 'environment'>): Promise<SecretBinding>
  list(): Promise<SecretRequestRecord[]>
  insert(entries: Array<SecretEntry & SecretBinding>): Promise<void>
  find(id: string): Promise<SecretRequestRecord | null>
  audit(record: SecretRequestRecord): Promise<void>
  deliver(record: SecretRequestRecord, binding: SecretBinding, value: string): Promise<void>
  fulfill(record: SecretRequestRecord): Promise<void>
  dismiss(id: string): Promise<void>
}
export async function listSecretRequests(port: SecretRequestPort): Promise<SecretRequestView[]> {
  await port.authorize()
  return (await port.list()).map(secretRequestView)
}
export async function requestSecrets(port: SecretRequestPort, input: SecretEntry[]): Promise<SecretRequestView[]> {
  await port.authorize()
  const entries = input.map((entry) => secretEntrySchema.parse(entry))
  const existing = await port.list()
  const pending: Array<SecretEntry & SecretBinding> = []
  for (const entry of entries) {
    const binding = await port.resolve(entry)
    const same = (candidate: SecretRequestRecord | (SecretEntry & SecretBinding)) => candidate.name === entry.name && candidate.target === binding.target && candidate.environment === binding.environment && candidate.targetRef === binding.targetRef && candidate.accountId === binding.accountId
    if (!existing.some(same) && !pending.some(same)) pending.push({ ...entry, ...binding })
  }
  if (existing.length + pending.length > 100) throw new SecretRequestError('Limite de 100 pedidos por projeto. Dispense pedidos antigos antes de solicitar outros.')
  if (pending.length) await port.insert(pending)
  return listSecretRequests(port)
}
export async function fulfillSecret(port: SecretRequestPort, id: string, value: string): Promise<void> {
  await port.authorize()
  const record = await port.find(id)
  if (!record || !record.target || !record.environment || !record.targetRef || !record.accountId) throw new SecretRequestError('Pedido não encontrado ou antigo sem destino confirmado. Solicite um novo pedido.')
  // A persisted name is revalidated: authenticated table access cannot turn a secret public.
  secretEntrySchema.parse({ name: record.name, description: record.description, target: record.target, environment: record.environment })
  const binding = await port.resolve({ target: record.target, environment: record.environment })
  assertSameBinding(record, binding)
  if (record.status === 'fulfilled') return
  await port.audit(record)
  await port.deliver(record, binding, value)
  try { await port.fulfill(record) }
  catch { throw new SecretRequestError('O valor foi enviado ao destino, mas o registro de confirmação falhou. Tente salvar novamente para confirmar o pedido.') }
}
export async function dismissRequestedSecret(port: SecretRequestPort, id: string): Promise<void> {
  await port.authorize()
  await port.dismiss(id)
}
