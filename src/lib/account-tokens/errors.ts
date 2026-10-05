export type AccountTokenErrorCode = 'reconnect_required' | 'refresh_pending' | 'unavailable'

const messages: Record<AccountTokenErrorCode, string> = {
  reconnect_required: 'A autorização da conta precisa ser renovada. Reconecte a conta em Contas.',
  refresh_pending: 'A conexão está sendo renovada por outra operação. Tente novamente em alguns segundos.',
  unavailable: 'Não foi possível confirmar a conexão agora. Tente novamente mais tarde.',
}

/** Never forward provider bodies, database errors or credentials to the client. */
export class AccountTokenError extends Error {
  constructor(public readonly code: AccountTokenErrorCode, message = messages[code]) {
    super(message)
    this.name = 'AccountTokenError'
  }
}

/** The provider explicitly rejected client authentication before rotating a token. */
export class AccountTokenClientRejectedError extends AccountTokenError {
  constructor() { super('unavailable') }
}
