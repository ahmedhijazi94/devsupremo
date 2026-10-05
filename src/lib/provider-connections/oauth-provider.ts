import type { ProtectedJsonRequest } from '../integrations/transport'
import { OAuthError, type OAuthConfiguration } from './oauth-contract'
import type { OAuthProvider } from './oauth-service'

/** OAuth protocol transport. Only the persisted owner configuration supplies URLs. */
export function oauthProvider(request: (input: ProtectedJsonRequest, config: OAuthConfiguration) => Promise<unknown>, clientSecret: (config: OAuthConfiguration) => Promise<string>): OAuthProvider {
  async function token(config: OAuthConfiguration, values: Record<string, string>): Promise<unknown> {
    const form = new URLSearchParams({ ...values, client_id: config.clientId })
    let authorization: ProtectedJsonRequest['authorization']
    if (config.clientAuthentication !== 'none') {
      const secret = await clientSecret(config)
      if (!secret || /[\u0000\r\n]/.test(secret)) throw new OAuthError('Credencial OAuth inválida.', 403)
      if (config.clientAuthentication === 'client_secret_post') form.set('client_secret', secret)
      else authorization = { kind: 'basic', value: Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(secret)}`).toString('base64') }
    }
    return request({ ...config.token, method: 'POST', body: form.toString(), contentType: 'application/x-www-form-urlencoded', ...(authorization ? { authorization } : {}) }, config)
  }
  return {
    async exchange(config, input) { return token(config, { grant_type: 'authorization_code', code: input.code, code_verifier: input.verifier, redirect_uri: input.redirectUri }) },
    async refresh(config, refreshToken) { return token(config, { grant_type: 'refresh_token', refresh_token: refreshToken }) },
    async identity(config, accessToken) {
      return request({ origin: config.connector.origin, path: config.connector.identity.path, method: 'GET', authorization: { kind: 'bearer', value: accessToken } }, config)
    },
  }
}
