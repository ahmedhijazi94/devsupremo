#!/usr/bin/env bash
# Same checks locally and in CI: repository history and the shipped scaffold CLI.
set -euo pipefail

scan_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
scan_binary="${GITLEAKS_BIN:-gitleaks}"
if [[ "$scan_binary" == */* ]]; then
  scan_binary="$(cd -- "$(dirname -- "$scan_binary")" && pwd)/$(basename -- "$scan_binary")"
fi
if ! command -v "$scan_binary" >/dev/null 2>&1; then
  printf '%s\n' 'Gitleaks não encontrado. Instale a versão aprovada pela CI ou informe GITLEAKS_BIN.' >&2
  exit 127
fi

umask 077
scan_tmp="$(mktemp -d "${TMPDIR:-/tmp}/supremo-secrets.XXXXXXXX")"
trap 'rm -rf -- "$scan_tmp"' EXIT
mkdir -p "$scan_tmp/scaffold/tools/supremo-cli/dist"
cp "$scan_root/packages/cli/dist/bin.js" "$scan_tmp/scaffold/tools/supremo-cli/dist/bin.js"
printf '[extend]\nuseDefault = true\n' > "$scan_tmp/default-gitleaks.toml"
: > "$scan_tmp/empty.gitleaksignore"

# Explicit configs/ignore files prevent a caller's environment from weakening
# the repository baseline or applying its bundle allowlist to the scaffold.
unset GITLEAKS_CONFIG GITLEAKS_CONFIG_TOML
scan_status=0
printf '%s\n' 'Verificando todo o histórico Git com a configuração e os fingerprints revisados do Supremo.'
if ! "$scan_binary" detect --source "$scan_root" --log-opts='--all --full-history' \
  --config "$scan_root/.gitleaks.toml" --gitleaks-ignore-path "$scan_root/.gitleaksignore" \
  --redact=100 --verbose --no-color --exit-code 1 --no-banner; then
  scan_status=1
fi

printf '%s\n' 'Verificando a CLI no caminho distribuído, com regras padrão e sem allowlist do repositório.'
if ! "$scan_binary" detect --source "$scan_tmp/scaffold" --no-git \
  --config "$scan_tmp/default-gitleaks.toml" --gitleaks-ignore-path "$scan_tmp/empty.gitleaksignore" \
  --redact=100 --verbose --no-color --exit-code 1 --no-banner; then
  scan_status=1
fi
exit "$scan_status"
