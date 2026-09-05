import type { NextConfig } from 'next'

// Sem Cross-Origin-Embedder-Policy: ele existia para o WebContainer e
// impediria o painel de embutir o preview publicado na Vercel.
const securityHeaders = [
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' }
]

const nextConfig: NextConfig = {
  // O scaffold lê scripts/security-audit.js do disco para copiá-lo nos
  // projetos gerados. Sem isto o arquivo não vai para o bundle de deploy
  // e o projeto novo nasce sem o gate de auditoria.
  outputFileTracingIncludes: {
    '/**': [
      './scripts/security-audit.js',
      './scripts/rls-isolation-*.mjs',
      './src/lib/templates/assets/**',
      './packages/cli/dist/bin.js',
      './packages/cli/package.json',
    ],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ]
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'avatars.githubusercontent.com' },
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
    ],
  },
}

export default nextConfig
