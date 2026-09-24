import { assertSameBinding, sameSecretConfiguration, secretEntrySchema, secretRequestView, validateSecretValue, SecretRequestError, type SecretBinding, type SecretEntry, type SecretRequestRecord, type SecretRequestView } from './policy'

/** Ports never persist the submitted value. Only deliver receives it. */
export interface SecretDeliveryClaim { id: string; expiresAt: string }
export interface SecretRequestPort {
  authorize(): Promise<void>
  resolve(entry: Pick<SecretEntry, 'target' | 'environment'>): Promise<SecretBinding>
  list(): Promise<SecretRequestRecord[]>
  insert(entries: Array<SecretEntry & SecretBinding>): Promise<void>
  find(id: string): Promise<SecretRequestRecord | null>
  audit(record: SecretRequestRecord): Promise<void>
  claim(record: SecretRequestRecord): Promise<SecretDeliveryClaim>
  release(record: SecretRequestRecord, claim: SecretDeliveryClaim): Promise<void>
  deliver(record: SecretRequestRecord, binding: SecretBinding, value: string, claim?: SecretDeliveryClaim): Promise<void>
  fulfill(record: SecretRequestRecord, claim?: SecretDeliveryClaim): Promise<void>
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
    const previous = existing.find(same) ?? pending.find(same)
    if (previous && !sameSecretConfiguration(previous.configuration, entry.configuration)) throw new SecretRequestError('Já existe um pedido com outra configuração para este campo. Dispense o pedido anterior e solicite um novo.')
    if (!existing.some(same) && !pending.some(same)) pending.push({ ...entry, ...binding })
  }
  if (existing.length + pending.length > 100) throw new SecretRequestError('Limite de 100 pedidos por projeto. Dispense pedidos antigos antes de solicitar outros.')
  if (pending.length) await port.insert(pending)
  await port.authorize()
  const saved = await port.list()
  // A concurrent request may win the unique-key upsert. Do not return another setup intent as ours.
  for (const entry of pending) {
    const persisted = saved.find((candidate) => candidate.name === entry.name && candidate.target === entry.target && candidate.environment === entry.environment && candidate.targetRef === entry.targetRef && candidate.accountId === entry.accountId)
    if (!persisted || !sameSecretConfiguration(persisted.configuration, entry.configuration)) throw new SecretRequestError('O pedido salvo não corresponde à configuração solicitada. Dispense o pedido anterior e solicite um novo.')
  }
  return saved.map(secretRequestView)
}
export async function fulfillSecret(port: SecretRequestPort, id: string, value: string, validate?: (record: SecretRequestRecord) => void): Promise<SecretRequestRecord> {
  await port.authorize()
  const record = await port.find(id)
  if (!record || !record.target || !record.environment || !record.targetRef || !record.accountId) throw new SecretRequestError('Pedido não encontrado ou antigo sem destino confirmado. Solicite um novo pedido.')
  // A persisted name is revalidated: authenticated table access cannot turn a secret public.
  secretEntrySchema.parse({ name: record.name, description: record.description, target: record.target, environment: record.environment,
    ...(record.configuration ? { configuration: record.configuration } : {}) })
  const binding = await port.resolve({ target: record.target, environment: record.environment })
  assertSameBinding(record, binding)
  if (record.status === 'fulfilled') throw new SecretRequestError('Este pedido já foi concluído. Solicite um novo campo seguro para enviar outro valor.')
  validate?.(record)
  validateSecretValue(record.configuration, value)
  const claim = await port.claim(record)
  let completed = false
  try {
    await port.audit(record)
    await port.deliver(record, binding, value, claim)
    try { await port.fulfill(record, claim); completed = true }
    catch { throw new SecretRequestError('O valor foi enviado ao destino, mas o registro de confirmação falhou. Confira o resultado antes de solicitar um novo campo seguro.') }
  } finally {
    // Successful confirmation consumes this claim atomically. Failure releases only our
    // own claim; an expired worker cannot release a newer worker's reservation.
    if (!completed) await port.release(record, claim)
  }
  return { ...record, status: 'fulfilled' }
}
export async function dismissRequestedSecret(port: SecretRequestPort, id: string): Promise<void> {
  await port.authorize()
  await port.dismiss(id)
}
