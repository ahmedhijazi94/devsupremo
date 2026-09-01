import crypto from 'crypto'

/**
 * Lógica pura do token de clone do bootstrap: construção do JWT RS256 do GitHub
 * App e detecção de se a chave do App está configurada. O I/O (chamar a API do
 * GitHub App para emitir o installation token, e a escolha installation vs
 * fallback) vive em `config.ts`, que é adapter e roda coberto pelo E2E.
 *
 * PREFERÊNCIA (least privilege): installation token repo-scoped, curto (≤1h),
 * emitido só para o repo do projeto (exige GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY).
 * FALLBACK: token user-to-server (8h) que o Supremo já guarda. Em ambos os casos
 * o token só é entregue pelo canal seguro e o CLI o usa sem colocá-lo em URL,
 * argv, .git/config, stdout/stderr ou log.
 */

export interface CloneToken {
  token: string
  scope: 'installation' | 'user'
  /** ISO; null quando não sabemos (fallback user token). */
  expiresAt: string | null
}

/** Há chave de App para emitir installation token repo-scoped? */
export function appAuthConfigured(): boolean {
  return Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY)
}

/** Vercel/CI costumam guardar a chave com \n literais — normaliza para PEM real. */
export function normalizePrivateKey(raw: string): string {
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw
}

const b64url = (input: string | Buffer): string =>
  (typeof input === 'string' ? Buffer.from(input) : input).toString('base64url')

/** JWT RS256 do App (curto, ≤10min). Pura e testável. */
export function buildAppJwt(
  appId: string,
  privateKeyPem: string,
  now: number = Date.now(),
): string {
  const iat = Math.floor(now / 1000) - 60 // tolera clock skew
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = { iat, exp: iat + 600, iss: appId }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(normalizePrivateKey(privateKeyPem))
  return `${signingInput}.${b64url(signature)}`
}
