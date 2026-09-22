/** This recognizes one setup command; it never grants host permission or edits a
 * turn. The wrapper may omit its own denial, leaving ordinary host approval in
 * place. All feature commands still enter the normal lifecycle gate. */
export function isOnboardingPrepare(
  payload: unknown,
  project: unknown,
  host: 'claude-code' | 'codex',
  root: string,
): boolean {
  // Keep this function self-contained: the dependency-free hook embeds its JS
  // before node_modules exists. No metadata here proves user consent.
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  const issuer = (value: unknown): string | null => {
    if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9:/._~-]+$/.test(value)) return null
    try {
      const url = new URL(value)
      if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) return null
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
    } catch { return null }
  }
  if (!record(payload) || !record(project) || !record(payload.tool_input) ||
    typeof root !== 'string' || !root.startsWith('/') || payload.cwd !== root ||
    (host !== 'claude-code' && host !== 'codex') ||
    typeof project.projectId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(project.projectId)) return false
  const tool = payload.tool_name
  if (typeof tool !== 'string' || !/^(?:Bash|(?:functions\.)?(?:exec_command|shell_command))$/.test(tool)) return false
  const input = payload.tool_input
  // Never let an override change the executable, its environment or workspace.
  // Host approval fields remain host-owned and have no authorization effect here.
  const keys = new Set(['command', 'cmd', 'cwd', 'workdir', 'description', 'timeout', 'timeout_ms',
    'yield_time_ms', 'max_output_tokens', 'login', 'tty', 'run_in_background',
    'sandbox_permissions', 'justification', 'prefix_rule'])
  if (Object.keys(input).some(key => !keys.has(key)) ||
    ('command' in input && 'cmd' in input) ||
    ('cwd' in input && input.cwd !== root) || ('workdir' in input && input.workdir !== root)) return false
  const command = input.command ?? input.cmd
  if (typeof command !== 'string' || command.length > 4096) return false
  // A deliberately narrow literal grammar: no quoting, escaping, interpolation,
  // separators, redirects, flags before node, arbitrary scripts or extra args.
  const match = /^node tools\/supremo-cli\/dist\/bin\.js prepare --url ([A-Za-z0-9:/._~-]+)(?: --host (claude-code|codex))?$/.exec(command)
  if (!match || (match[2] !== undefined && match[2] !== host)) return false
  const expected = issuer(project.supremoUrl)
  return expected !== null && issuer(match[1]) === expected
}

/** Embed the same tested parser in the pre-install hook without importing CLI
 * dependencies. The generated declaration expects payload/project/host/root at
 * its call site, and does not read or trust onboarding/readiness receipts. */
export function onboardingHookParserSource(): string {
  return `const isOnboardingPrepare = ${isOnboardingPrepare.toString()}\n`
}
