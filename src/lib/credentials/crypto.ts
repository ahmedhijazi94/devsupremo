import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { z } from 'zod'

const VERSION = 'v1'
const MAX_CREDENTIAL_BYTES = 16_384
const NONCE_BYTES = 12
const TAG_BYTES = 16
const MAX_ENVELOPE_LENGTH = 61 + MAX_CREDENTIAL_BYTES * 2
const contextSchema = z.object({
  id: z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  userId: z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  projectId: z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  environment: z.enum(['development', 'preview', 'production']),
}).strict()

export type CredentialEncryptionContext = z.infer<typeof contextSchema>

function associatedData(context: CredentialEncryptionContext): Buffer {
  const parsed = contextSchema.safeParse(context)
  if (!parsed.success) throw new Error('Contexto da credencial inválido.')
  const { id, userId, projectId, environment } = parsed.data
  return Buffer.from(JSON.stringify([
    'supremo-project-credential', VERSION,
    id.toLowerCase(), userId.toLowerCase(), projectId.toLowerCase(), environment,
  ]), 'utf8')
}

function encryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY
  if (!key || key.length !== 64 || !/^[0-9a-f]{64}$/i.test(key)) {
    throw new Error('A chave de criptografia do cofre não está configurada corretamente.')
  }
  return Buffer.from(key, 'hex')
}

/** Server-side only. The credential is authenticated to its exact owner and scope. */
export function encryptCredential(value: string, context: CredentialEncryptionContext): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_BYTES
    || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new Error('Valor da credencial inválido.')
  }
  const aad = associatedData(context)
  const key = encryptionKey()
  try {
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
    cipher.setAAD(aad)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return `${VERSION}:${nonce.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`
  } catch {
    throw new Error('Não foi possível proteger a credencial.')
  } finally {
    key.fill(0)
  }
}

/** Decryption requires the authorized database row context, never client-provided scope. */
export function decryptCredential(ciphertext: string, context: CredentialEncryptionContext): string {
  if (typeof ciphertext !== 'string' || ciphertext.length > MAX_ENVELOPE_LENGTH
    || !/^v1:[0-9a-f]{24}:[0-9a-f]{32}:(?:[0-9a-f]{2})+(?![\s\S])/.test(ciphertext)) {
    throw new Error('Formato da credencial protegida inválido.')
  }
  const aad = associatedData(context)
  const key = encryptionKey()
  const [, nonce, tag, encrypted] = ciphertext.split(':') as [string, string, string, string]
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'hex'), { authTagLength: TAG_BYTES })
    decipher.setAAD(aad)
    decipher.setAuthTag(Buffer.from(tag, 'hex'))
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'hex')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Não foi possível acessar a credencial protegida.')
  } finally {
    key.fill(0)
  }
}
