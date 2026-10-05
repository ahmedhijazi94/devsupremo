export class IntegrationError extends Error {
  constructor(message: string, readonly code: 'invalid' | 'forbidden' | 'unavailable' | 'outcome_unknown' | 'rate_limited' = 'invalid', readonly httpStatus?: number) { super(message); this.name = 'IntegrationError' }
}
