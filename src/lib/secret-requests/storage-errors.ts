import { z } from 'zod'
import { SecretRequestError } from './policy'

const databaseErrorSchema = z.object({ code: z.string() })
const missingStructureCodes = new Set(['42703', '42P01', 'PGRST204', 'PGRST205'])
const authenticationCodes = new Set(['PGRST301', 'PGRST302', 'PGRST303'])

/** Use only stable database codes: messages/details can contain sensitive data.
 * A missing column/table may also be a stale API schema cache, so a read failure
 * alone must never claim that a specific migration has not been applied.
 */
export function secretRequestStorageError(error: unknown): SecretRequestError {
  const parsed = databaseErrorSchema.safeParse(error)
  const code = parsed.success ? parsed.data.code : ''
  if (missingStructureCodes.has(code)) return new SecretRequestError(
    'A estrutura dos pedidos de chaves não está disponível no banco do Supremo. É necessário concluir a atualização desse banco ou recarregar seu esquema. O banco do seu app não precisa ser alterado.',
    'schema_unavailable',
  )
  if (code === '42501') return new SecretRequestError(
    'O banco do Supremo negou acesso aos pedidos de chaves. As permissões precisam ser verificadas; tentar novamente não corrige essa restrição.',
    'access_denied',
  )
  if (authenticationCodes.has(code)) return new SecretRequestError(
    'A autenticação da consulta aos pedidos de chaves foi recusada. Atualize sua sessão; se persistir, verifique a conexão do Supremo com seu banco.',
    'authentication_failed',
  )
  return new SecretRequestError(
    'Não foi possível acessar os pedidos de chaves no banco do Supremo. Tente novamente; se persistir, verifique a conexão e os registros do serviço.',
    'storage_unavailable',
  )
}
