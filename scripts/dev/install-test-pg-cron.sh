#!/usr/bin/env bash
# CI only: run inside the disposable postgres:17 service, never on the host.
set -euo pipefail
if [[ ! -f /.dockerenv || "${SUPREMO_DISPOSABLE_PG_CRON:-}" != "1" ]]; then
  echo 'Refusing installation outside an explicitly authorized disposable PostgreSQL container.' >&2
  exit 2
fi
if [[ "$(id -u)" != "0" || "${PG_MAJOR:-}" != "17" ]]; then
  echo 'This isolated installer requires the root user in the postgres:17 CI service.' >&2
  exit 2
fi
if [[ -z "${PGDATA:-}" || ! -f "$PGDATA/PG_VERSION" || "$(cat "$PGDATA/PG_VERSION")" != "17" ]]; then
  echo 'Expected the disposable PostgreSQL 17 data directory.' >&2
  exit 2
fi
cron_database="${SUPREMO_TEST_CRON_DATABASE:-supremo_jobs_ci}"
if [[ ! "$cron_database" =~ ^supremo_jobs_[a-z0-9_]+$ ]]; then
  echo 'Invalid disposable cron database name.' >&2
  exit 2
fi
cron_tag='v1.6.7'
cron_commit='465b38c737f584d520229f5a1d69d1d44649e4e5'
test_pg_config='/usr/lib/postgresql/17/bin/pg_config'
source_dir="$(mktemp -d /tmp/supremo-pg-cron.XXXXXX)"
trap 'rm -rf -- "$source_dir"' EXIT
apt-get update -o Acquire::Retries=3
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential ca-certificates git postgresql-server-dev-17
"$test_pg_config" --version
git init -q "$source_dir"
git -C "$source_dir" remote add origin https://github.com/citusdata/pg_cron.git
git -C "$source_dir" fetch -q --depth 1 origin "refs/tags/$cron_tag"
if [[ "$(git -C "$source_dir" rev-parse FETCH_HEAD)" != "$cron_commit" ]]; then
  echo 'pg_cron source identity mismatch; refusing compilation.' >&2
  exit 1
fi
git -C "$source_dir" checkout -q --detach "$cron_commit"
make -C "$source_dir" -j2 PG_CONFIG="$test_pg_config"
make -C "$source_dir" PG_CONFIG="$test_pg_config" install
psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 -c "ALTER SYSTEM SET shared_preload_libraries = 'pg_cron'"
# Custom GUCs are registered only after preload. Append them to this service's
# own config before restart, rather than ALTER SYSTEM against an unloaded module.
cat >> "$PGDATA/postgresql.conf" <<CONFIG
cron.database_name = '$cron_database'
cron.use_background_workers = on
cron.log_run = on
CONFIG
psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 -c "ALTER SYSTEM SET max_worker_processes = '16'"
echo "Installed pg_cron $cron_tag ($cron_commit) in the disposable service. Restart only this container before the real scheduler test."
