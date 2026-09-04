import { describe, it, expect } from 'vitest'
import { classifyNpmAuditFailure } from './npm-audit-classify'

// Fixtures: saída REAL do `npm audit --audit-level=high` (modo texto, não
// --json) para cada categoria. Cobrem os dois incidentes reais que
// motivaram este gate (400 "Invalid package tree" e 503) mais o formato
// genuíno de vulnerabilidade e de outros erros do npm.

const VULNERABILITY_REPORT = `
# npm audit report

lodash  <4.17.21
Severity: high
Prototype Pollution - https://github.com/advisories/GHSA-jf85-cpcp-j695
fix available via \`npm audit fix\`
node_modules/lodash

1 high severity vulnerability

To address all issues, run:
  npm audit fix
`

const INVALID_PACKAGE_TREE_400 = `
npm error code E400
npm error 400 Bad Request - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - Invalid package tree, run npm install to rebuild your package-lock.json
`

const SERVICE_UNAVAILABLE_503 = `
npm error code E503
npm error 503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk
`

const RATE_LIMITED_429 = `
npm error code E429
npm error 429 Too Many Requests - GET https://registry.npmjs.org/lodash
`

const CONN_RESET = `
npm error code ECONNRESET
npm error network socket hang up
npm error network This is a problem related to network connectivity.
`

const ETIMEDOUT = `
npm error code ETIMEDOUT
npm error network request to https://registry.npmjs.org/lodash failed, reason: connect ETIMEDOUT 104.16.24.35:443
`

const DNS_FAILURE = `
npm error code EAI_AGAIN
npm error network getaddrinfo EAI_AGAIN registry.npmjs.org
`

const AUTH_ERROR_REAL = `
npm error code E403
npm error 403 Forbidden - GET https://registry.npmjs.org/some-private-pkg - Forbidden
`

const NOT_FOUND_REAL = `
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/pacote-inexistente - Not found
`

const GENERIC_400_WITHOUT_TREE_TEXT = `
npm error code E400
npm error 400 Bad Request - GET https://registry.npmjs.org/foo - some other reason entirely
`

describe('classifyNpmAuditFailure — vulnerabilidade real (falha imediata)', () => {
  it('relatório de vulnerabilidade high (sem nenhuma linha "npm error") → vulnerability', () => {
    expect(classifyNpmAuditFailure(VULNERABILITY_REPORT)).toBe('vulnerability')
  })

  it('múltiplas vulnerabilidades também classificam como vulnerability', () => {
    const many = `${VULNERABILITY_REPORT}\nnode-fetch  <2.6.7\nSeverity: critical\n...\n\n2 vulnerabilities`
    expect(classifyNpmAuditFailure(many)).toBe('vulnerability')
  })
})

describe('classifyNpmAuditFailure — instabilidade transitória do registry (elegível a retry)', () => {
  it('400 "Invalid package tree" (incidente real — supremo-cli 1.2.6) → transient', () => {
    expect(classifyNpmAuditFailure(INVALID_PACKAGE_TREE_400)).toBe('transient')
  })

  it('503 Service Unavailable (incidente real) → transient', () => {
    expect(classifyNpmAuditFailure(SERVICE_UNAVAILABLE_503)).toBe('transient')
  })

  it('429 Too Many Requests → transient', () => {
    expect(classifyNpmAuditFailure(RATE_LIMITED_429)).toBe('transient')
  })

  it('qualquer 5xx (não só 503) → transient', () => {
    expect(classifyNpmAuditFailure('npm error code E500\nnpm error 500 Internal Server Error')).toBe(
      'transient',
    )
    expect(classifyNpmAuditFailure('npm error code E502\nnpm error 502 Bad Gateway')).toBe('transient')
    expect(classifyNpmAuditFailure('npm error code E504\nnpm error 504 Gateway Timeout')).toBe(
      'transient',
    )
  })

  it('ECONNRESET / socket hang up → transient', () => {
    expect(classifyNpmAuditFailure(CONN_RESET)).toBe('transient')
  })

  it('ETIMEDOUT → transient', () => {
    expect(classifyNpmAuditFailure(ETIMEDOUT)).toBe('transient')
  })

  it('falha de DNS (EAI_AGAIN) → transient', () => {
    expect(classifyNpmAuditFailure(DNS_FAILURE)).toBe('transient')
  })

  it('timeout descrito em texto livre, sem código reconhecido → transient', () => {
    expect(
      classifyNpmAuditFailure('npm error network request timed out after 30000ms'),
    ).toBe('transient')
  })

  it('"timed out" ou "socket hang up" sem o prefixo "npm error network" → ainda transient', () => {
    expect(classifyNpmAuditFailure('npm error code EAI_FAIL\nnpm error the request timed out')).toBe(
      'transient',
    )
    expect(
      classifyNpmAuditFailure('npm error code EAI_FAIL\nnpm error socket hang up'),
    ).toBe('transient')
  })
})

describe('classifyNpmAuditFailure — erro real do npm (falha imediata, sem retry)', () => {
  it('403 Forbidden (permissão real) → error', () => {
    expect(classifyNpmAuditFailure(AUTH_ERROR_REAL)).toBe('error')
  })

  it('404 Not Found (pacote real inexistente) → error', () => {
    expect(classifyNpmAuditFailure(NOT_FOUND_REAL)).toBe('error')
  })

  it('400 SEM o texto "Invalid package tree" não herda o tratamento do incidente conhecido → error', () => {
    expect(classifyNpmAuditFailure(GENERIC_400_WITHOUT_TREE_TEXT)).toBe('error')
  })

  it('erro desconhecido/não mapeado do npm → error (fail-closed por padrão, nunca retry silencioso)', () => {
    expect(
      classifyNpmAuditFailure('npm error code EUSAGE\nnpm error This is not the npm you are looking for.'),
    ).toBe('error')
  })
})
