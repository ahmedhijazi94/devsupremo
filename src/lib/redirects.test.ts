import { describe, it, expect } from 'vitest'
import { safeRedirectPath } from './redirects'

describe('safeRedirectPath — caminhos internos aceitos', () => {
  it.each([
    '/dashboard',
    '/projects',
    '/projects/abc-123',
    '/settings?tab=perfil',
    '/projects/1#topo',
  ])('aceita %s', (path) => {
    expect(safeRedirectPath(path)).toBe(path)
  })
})

describe('safeRedirectPath — open redirect bloqueado', () => {
  // Cada um destes, concatenado a um origin, leva o navegador para fora
  // do domínio mantendo a URL de origem com aparência legítima.
  it.each([
    ['//evil.com', 'protocolo-relativa com duas barras'],
    ['///evil.com', 'três barras'],
    ['/\\evil.com', 'barra invertida — navegadores normalizam para //'],
    ['/\\/evil.com', 'barra invertida seguida de barra'],
    ['https://evil.com', 'URL absoluta'],
    ['http://evil.com', 'URL absoluta sem TLS'],
    ['/redirect?to=https://evil.com', 'esquema embutido'],
    ['javascript:alert(1)', 'esquema javascript'],
    ['evil.com', 'sem barra inicial'],
  ])('bloqueia %s (%s)', (path) => {
    expect(safeRedirectPath(path)).toBe('/dashboard')
  })

  it('bloqueia injeção de cabeçalho por quebra de linha', () => {
    expect(safeRedirectPath('/ok\r\nLocation: https://evil.com')).toBe(
      '/dashboard',
    )
    expect(safeRedirectPath('/ok\nSet-Cookie: a=b')).toBe('/dashboard')
  })
})

describe('safeRedirectPath — ausência de valor', () => {
  it.each([null, undefined, ''])('usa o fallback para %s', (value) => {
    expect(safeRedirectPath(value)).toBe('/dashboard')
  })

  it('respeita um fallback customizado', () => {
    expect(safeRedirectPath(null, '/login')).toBe('/login')
    expect(safeRedirectPath('//evil.com', '/login')).toBe('/login')
  })
})
