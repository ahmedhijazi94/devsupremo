/**
 * Validação de destino de redirect.
 *
 * `//evil.com` e `/\evil.com` são lidos pelo navegador como URL
 * protocolo-relativa: concatenados a um origin, levam para fora do domínio.
 * É o open redirect clássico de tela de login — a URL na barra de endereço
 * continua parecendo legítima enquanto a página já é de outro site.
 */
export function safeRedirectPath(
  raw: string | null | undefined,
  fallback = '/dashboard',
): string {
  if (!raw) return fallback

  // Só caminho interno, começando com uma única barra.
  if (!raw.startsWith('/')) return fallback
  if (raw.startsWith('//')) return fallback
  if (/^\/[\\/]/.test(raw)) return fallback
  if (raw.includes('://')) return fallback
  if (/[\r\n\t]/.test(raw)) return fallback

  return raw
}
