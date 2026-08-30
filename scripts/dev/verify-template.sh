#!/usr/bin/env bash
# Gera um projeto do template e roda a sequência exata do CI.
#
# Existe porque verificar parcialmente já deixou passar dois bugs: um por
# usar `npm install` onde o CI usa `npm ci`, outro por não rodar `typecheck`
# depois de mexer no gerador de testes de RLS.
set -euo pipefail

OUT="${1:-/tmp/supremo-template-check}"
cd "$(dirname "$0")/../.."

rm -rf "$OUT"
npx tsx scripts/dev/generate-sample-project.ts "$OUT" >/dev/null
cd "$OUT"

export NEXT_PUBLIC_SUPABASE_URL="https://placeholder.supabase.co"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="placeholder"

echo "── npm ci ──"
npm ci --silent

fail=0
for gate in typecheck lint test test:coverage build; do
  if npm run "$gate" >/tmp/gate-$gate.log 2>&1; then
    printf "  ✓ %-16s\n" "$gate"
  else
    printf "  ✗ %-16s\n" "$gate"; tail -15 /tmp/gate-$gate.log; fail=1
  fi
done

if npm run audit:security -- --strict >/tmp/gate-audit.log 2>&1; then
  printf "  ✓ %-16s\n" "audit:security"
else
  printf "  ✗ %-16s\n" "audit:security"; tail -10 /tmp/gate-audit.log; fail=1
fi

exit $fail
