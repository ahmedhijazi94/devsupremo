// Static content of the security audit script for new projects.
// Stored as a regular string to avoid TypeScript template literal interpolation issues.
// DO NOT use backtick template literals in this file for the script content.

export function getSecurityAuditScriptContent(): string {
  const lines: string[] = [
    '#!/usr/bin/env node',
    '// SUPREMO SECURITY AUDIT — auto-generated, do not edit manually.',
    '// Usage: node scripts/security-audit.js [--strict]',
    '// Audits: RLS, Frontend Gates, IDOR, Hardcoded Secrets, XSS',
    '',
    "const fs = require('fs')",
    "const path = require('path')",
    "const { execSync } = require('child_process')",
    '',
    'const ROOT = path.resolve(__dirname, "..")',
    'const STRICT = process.argv.includes("--strict")',
    'const COLORS = {',
    '  CRITICAL: "\\x1b[41m\\x1b[37m", HIGH: "\\x1b[31m", MEDIUM: "\\x1b[33m",',
    '  LOW: "\\x1b[34m", INFO: "\\x1b[32m", RESET: "\\x1b[0m",',
    '}',
    '',
    'const findings = []',
    'const strengths = []',
    '',
    'function finding(severity, category, file, line, code, reason) {',
    '  findings.push({ severity, category, file, line, code, reason })',
    '  const col = COLORS[severity] || COLORS.RESET',
    '  console.log(col + "[" + severity + "][" + category + "] " + file + ":" + line + COLORS.RESET)',
    '  console.log("  Why: " + reason + "\\n")',
    '}',
    '',
    'function strength(msg) {',
    '  strengths.push(msg)',
    '  console.log(COLORS.INFO + "[OK] " + msg + COLORS.RESET)',
    '}',
    '',
    'function collectFiles(dir, exts, ignore) {',
    '  ignore = ignore || ["node_modules", ".next", "dist", ".git"]',
    '  var results = []',
    '  if (!fs.existsSync(dir)) return results',
    '  fs.readdirSync(dir, { withFileTypes: true }).forEach(function(entry) {',
    '    if (ignore.some(function(ig) { return entry.name === ig })) return',
    '    var full = path.join(dir, entry.name)',
    '    if (entry.isDirectory()) results = results.concat(collectFiles(full, exts, ignore))',
    '    else if (exts.some(function(e) { return entry.name.endsWith(e) })) results.push(full)',
    '  })',
    '  return results',
    '}',
    '',
    'function rel(f) { return path.relative(ROOT, f) }',
    '',
    'var tsFiles = collectFiles(path.join(ROOT, "src"), [".ts", ".tsx"])',
    'var sqlFiles = collectFiles(ROOT, [".sql"])',
    'var actionFiles = tsFiles.filter(function(f) {',
    '  return f.includes("actions/") || (f.includes("route.ts") && !f.includes("callback"))',
    '})',
    '',
    '// CAT 1: RLS',
    'console.log("\\n=== CAT 1: BANCO SEM TRANCA (RLS) ===")',
    'sqlFiles.forEach(function(file) {',
    '  var content = fs.readFileSync(file, "utf8")',
    '  var matches = content.match(/CREATE TABLE (?:IF NOT EXISTS )?(\\w+)/gi) || []',
    '  matches.forEach(function(m) {',
    '    var t = m.replace(/CREATE TABLE (?:IF NOT EXISTS )?/i, "")',
    '    if (!content.includes("ALTER TABLE " + t + " ENABLE ROW LEVEL SECURITY") &&',
    '        !content.includes(\'ALTER TABLE "\' + t + \'\" ENABLE ROW LEVEL SECURITY\'))',
    '      finding("CRITICAL", "RLS", rel(file), 0, m, \'Table "\' + t + \'" has no RLS policy — any user can read/write all rows.\')',
    '    else strength(\'Table "\' + t + \'" has RLS enabled\')',
    '  })',
    '})',
    '',
    '// CAT 2: Auth missing in server actions',
    'console.log("\\n=== CAT 2: PERMISSÃO NO SERVIDOR ===")',
    'actionFiles.forEach(function(file) {',
    '  var c = fs.readFileSync(file, "utf8")',
    '  if (!c.includes("export async function") && !c.includes("export function")) return',
    '  if (!c.includes("getUser()") && !c.includes("auth.getSession") && !c.includes("supabase.auth"))',
    '    finding("CRITICAL", "AUTH_MISSING", rel(file), 1, "export...", "No auth check in server action/route.")',
    '  else strength(rel(file) + ": has auth check")',
    '})',
    '',
    '// CAT 3: IDOR',
    'console.log("\\n=== CAT 3: IDOR ===")',
    'var idorFound = 0',
    'actionFiles.forEach(function(file) {',
    '  var lines = fs.readFileSync(file, "utf8").split("\\n")',
    '  lines.forEach(function(line, i) {',
    '    if (line.match(/\\.eq\\([\'"]id[\'"],/)) {',
    '      var ctx = lines.slice(Math.max(0, i-5), i+5).join("\\n")',
    '      if (!ctx.includes("user_id") && !ctx.includes("user.id") && !ctx.includes("auth.uid")) {',
    '        finding("HIGH", "IDOR", rel(file), i+1, line, ".eq(\\"id\\") without ownership check.")',
    '        idorFound++',
    '      }',
    '    }',
    '  })',
    '})',
    'if (idorFound === 0) strength("No IDOR patterns detected")',
    '',
    '// CAT 4: Hardcoded Secrets',
    'console.log("\\n=== CAT 4: CHAVES EXPOSTAS ===")',
    'var secretPatterns = [',
    '  { r: /eyJhbGciOi[a-zA-Z0-9._-]{20,}/g, l: "JWT hardcoded" },',
    '  { r: /ghp_[a-zA-Z0-9]{36}/g, l: "GitHub PAT" },',
    '  { r: /sbp_[a-zA-Z0-9]{40}/g, l: "Supabase PAT" },',
    '  { r: /GOCSPX-[a-zA-Z0-9_-]{28}/g, l: "Google Client Secret" },',
    '  { r: /sk_live_[a-zA-Z0-9]{20,}/g, l: "Stripe Live Key" },',
    ']',
    'var allFiles = collectFiles(ROOT, [".ts",".tsx",".js",".json",".yml",".yaml"])',
    'var secretsFound = 0',
    'allFiles.forEach(function(file) {',
    '  var relf = rel(file)',
    '  if (relf.includes(".env.local") || relf.endsWith(".env.example") || relf.includes("security-audit")) return',
    '  var c = fs.readFileSync(file, "utf8")',
    '  secretPatterns.forEach(function(sp) {',
    '    var re = new RegExp(sp.r.source, "g")',
    '    var m',
    '    while ((m = re.exec(c)) !== null) {',
    '      var ln = c.substring(0, m.index).split("\\n").length',
    '      finding("CRITICAL", "SECRET", relf, ln, m[0], sp.l + " hardcoded. Rotate immediately.")',
    '      secretsFound++',
    '    }',
    '  })',
    '})',
    'var gi = fs.existsSync(path.join(ROOT,".gitignore")) ? fs.readFileSync(path.join(ROOT,".gitignore"),"utf8") : ""',
    'if (gi.includes(".env.local") || gi.includes(".env*.local")) strength(".env.local is in .gitignore")',
    'else finding("CRITICAL","SECRET",".gitignore",1,"",".env.local not in .gitignore!")',
    'if (secretsFound === 0) strength("No hardcoded secrets detected")',
    '',
    '// CAT 5: XSS',
    'console.log("\\n=== CAT 5: INPUTS SEM TRATAMENTO (XSS) ===")',
    'var xssFound = 0',
    'tsFiles.forEach(function(file) {',
    '  var c = fs.readFileSync(file, "utf8")',
    '  var lines = c.split("\\n")',
    '  var xssPatterns = [',
    '    { r: /dangerouslySetInnerHTML\\s*=\\s*\\{\\s*\\{/g, l: "dangerouslySetInnerHTML" },',
    '    { r: /innerHTML\\s*=/g, l: "innerHTML" },',
    '    { r: /eval\\s*\\(/g, l: "eval()" },',
    '    { r: /new\\s+Function\\s*\\(/g, l: "new Function()" },',
    '  ]',
    '  xssPatterns.forEach(function(xp) {',
    '    var re = new RegExp(xp.r.source, "g")',
    '    var m',
    '    while ((m = re.exec(c)) !== null) {',
    '      var ln = c.substring(0, m.index).split("\\n").length',
    '      var ctx = lines.slice(Math.max(0,ln-3),ln+3).join("\\n")',
    '      if (!ctx.includes("sanitize") && !ctx.includes("DOMPurify")) {',
    '        finding("HIGH","XSS",rel(file),ln,lines[ln-1]||"",xp.l+" without sanitization.")',
    '        xssFound++',
    '      }',
    '    }',
    '  })',
    '})',
    'if (xssFound === 0) strength("No XSS vectors detected")',
    'if (tsFiles.some(function(f){return fs.readFileSync(f,"utf8").includes("from \'zod\'")})) strength("Zod used for server-side validation")',
    '',
    '// npm audit',
    'console.log("\\n=== BONUS: DEPENDENCY VULNERABILITIES ===")',
    'try {',
    '  var a = JSON.parse(execSync("npm audit --json 2>/dev/null", { cwd: ROOT }).toString())',
    '  var v = (a.metadata || {}).vulnerabilities || {}',
    '  if ((v.critical||0) > 0) finding("CRITICAL","DEPENDENCY","package.json",0,"",v.critical+" critical vulns. Run npm audit fix.")',
    '  else strength("npm audit: " + (v.high||0) + " high, " + (v.moderate||0) + " moderate")',
    '} catch(e) { console.log("npm audit skipped:", e.message) }',
    '',
    '// Summary',
    'var bySev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }',
    'findings.forEach(function(f) { bySev[f.severity] = (bySev[f.severity]||0)+1 })',
    'console.log("\\n" + "=".repeat(50))',
    'console.log("SECURITY AUDIT SUMMARY")',
    'console.log("CRITICAL:" + bySev.CRITICAL + " | HIGH:" + bySev.HIGH + " | MEDIUM:" + bySev.MEDIUM + " | LOW:" + bySev.LOW)',
    'console.log("Strengths: " + strengths.length)',
    '',
    'fs.mkdirSync(path.join(ROOT,"docs","security-audit"),{recursive:true})',
    'fs.writeFileSync(',
    '  path.join(ROOT,"docs","security-audit","last-audit.json"),',
    '  JSON.stringify({timestamp:new Date().toISOString(),summary:bySev,strengths:strengths,findings:findings},null,2)',
    ')',
    'console.log("Report saved: docs/security-audit/last-audit.json")',
    '',
    'if (STRICT && (bySev.CRITICAL > 0 || bySev.HIGH > 0)) {',
    '  console.log("\\nAUDIT FAILED — fix critical/high findings before commit.")',
    '  process.exit(1)',
    '} else if (findings.length === 0) {',
    '  console.log("\\nAUDIT PASSED — no security issues found!")',
    '} else {',
    '  console.log("\\nAUDIT COMPLETE — review findings above.")',
    '}',
  ]
  return lines.join('\n')
}

export function getCiWorkflowContent(projectName: string): string {
  const lines: string[] = [
    'name: Security + Quality Gates — ' + projectName,
    '',
    'on:',
    '  push:',
    '    branches: [main, develop]',
    '  pull_request:',
    '    branches: [main]',
    '',
    'jobs:',
    '  security-audit:',
    '    name: Security Audit',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: "20"',
    '          cache: npm',
    '      - run: npm ci',
    '      - run: npm run audit:security -- --strict',
    '',
    '  quality:',
    '    name: Lint & Types',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with: { node-version: "20", cache: npm }',
    '      - run: npm ci',
    '      - run: npx tsc --noEmit',
    '      - run: npm run lint',
    '',
    '  test-unit:',
    '    name: Unit Tests (Vitest)',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with: { node-version: "20", cache: npm }',
    '      - run: npm ci',
    '      - run: npm run test',
    '',
    '  test-e2e:',
    '    name: E2E Tests (Playwright)',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with: { node-version: "20", cache: npm }',
    '      - run: npm ci',
    '      - run: npx playwright install --with-deps',
    '      - run: npm run test:e2e',
    '',
    '  build:',
    '    name: Production Build',
    '    runs-on: ubuntu-latest',
    '    needs: [security-audit, quality, test-unit, test-e2e]',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with: { node-version: "20", cache: npm }',
    '      - run: npm ci',
    '      - run: npm run build',
  ]
  return lines.join('\n')
}

export function getPackageJsonContent(projectName: string): string {
  return JSON.stringify({
    name: projectName,
    version: "0.1.0",
    private: true,
    scripts: {
      dev: "next dev",
      build: "next build",
      start: "next start",
      lint: "next lint",
      test: "vitest run",
      "test:watch": "vitest",
      "test:e2e": "playwright test",
      "test:e2e:ui": "playwright test --ui",
      "audit:security": "node scripts/security-audit.js"
    },
    dependencies: {
      "@supabase/supabase-js": "^2.39.0",
      "next": "15.0.0",
      "react": "^18.2.0",
      "react-dom": "^18.2.0",
      "zod": "^3.22.4"
    },
    devDependencies: {
      "@playwright/test": "^1.40.1",
      "@testing-library/react": "^14.1.2",
      "@types/node": "^20",
      "@types/react": "^18",
      "@types/react-dom": "^18",
      "@vitejs/plugin-react": "^4.2.1",
      "eslint": "^8",
      "eslint-config-next": "15.0.0",
      "jsdom": "^23.0.1",
      "typescript": "^5",
      "vitest": "^1.1.0"
    }
  }, null, 2)
}

export function getVitestConfigContent(): string {
  return `import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
})
`
}

export function getPlaywrightConfigContent(): string {
  return `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
});
`
}

export function getVercelJsonContent(): string {
  return JSON.stringify({
    "version": 2,
    "headers": [
      {
        "source": "/(.*)",
        "headers": [
          {
            "key": "X-Content-Type-Options",
            "value": "nosniff"
          },
          {
            "key": "X-Frame-Options",
            "value": "DENY"
          },
          {
            "key": "X-XSS-Protection",
            "value": "1; mode=block"
          },
          {
            "key": "Referrer-Policy",
            "value": "strict-origin-when-cross-origin"
          },
          {
            "key": "Permissions-Policy",
            "value": "camera=(), microphone=(), geolocation=()"
          }
        ]
      }
    ],
    "crons": [
      {
        "path": "/api/cron",
        "schedule": "0 * * * *"
      }
    ]
  }, null, 2)
}

export function getTailwindConfigContent(): string {
  return `import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
export default config
`
}

export function getPostcssConfigContent(): string {
  return `module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
`
}

export function getGlobalsCssContent(): string {
  return `@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --background: #ffffff;
  --foreground: #171717;
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: #0a0a0a;
    --foreground: #ededed;
  }
}

body {
  color: var(--foreground);
  background: var(--background);
  font-family: Arial, Helvetica, sans-serif;
}
`
}

export function getUtilsTsContent(): string {
  return `import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
`
}

export function getSupabaseClientContent(): string {
  return `import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
`
}

export function getSupabaseServerContent(): string {
  return `import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options)
            })
          } catch (error) {
            // The \`set\` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  )
}
`
}

export function getSupabaseMiddlewareContent(): string {
  return `import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({
            request,
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  await supabase.auth.getUser()

  return supabaseResponse
}
`
}

export function getNextMiddlewareContent(): string {
  return `import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function middleware(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
`
}
