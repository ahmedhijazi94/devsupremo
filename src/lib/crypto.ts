import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16

function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY
  if (!key || key.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string')
  }
  return Buffer.from(key, 'hex')
}

/**
 * Encrypts a string using AES-256-GCM.
 * Returns a string in the format: iv:authTag:encryptedData (all hex encoded)
 */
export function encryptToken(text: string): string {
  if (!text) return text

  const iv = crypto.randomBytes(IV_LENGTH)
  const key = getKey()

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  
  const authTag = cipher.getAuthTag()

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`
}

/**
 * Decrypts a string that was encrypted with encryptToken.
 * Expects the format: iv:authTag:encryptedData (all hex encoded)
 */
export function decryptToken(encryptedText: string): string {
  if (!encryptedText) return encryptedText
  
  const parts = encryptedText.split(':')
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted text format')
  }

  const [ivHex, authTagHex, encryptedDataHex] = parts
  const iv = Buffer.from(ivHex!, 'hex')
  const authTag = Buffer.from(authTagHex!, 'hex')
  const key = getKey()

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  let decrypted = decipher.update(encryptedDataHex!, 'hex', 'utf8')
  decrypted += decipher.final('utf8')

  return decrypted
}
