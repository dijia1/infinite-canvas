#!/usr/bin/env bash
# Owns a fresh local database/container. Never targets an existing application server.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
read -r -a user_stages <<< "${LOADTEST_USERS:-10 30 50}"
for users in "${user_stages[@]}"; do
  case "$users" in 10|30|50) ;; *) echo "LOADTEST_USERS must contain 10, 30 or 50" >&2; exit 1 ;; esac
done
if [[ ${#user_stages[@]} -eq 0 ]]; then echo "No user stages selected" >&2; exit 1; fi
run_dir="${1:-$(mktemp -d /tmp/infinite-canvas-loadtest-XXXXXX)}"
mkdir -p "$run_dir"
run_dir="$(cd "$run_dir" && pwd)"
if [[ -n "$(ls -A "$run_dir")" ]]; then
  echo "Use a new empty result directory: $run_dir" >&2
  exit 1
fi
container_name="infinite-canvas-loadtest-$(date +%s)-$$"
api_pid=""
monitor_pid=""
cleanup() {
  if [[ -n "$monitor_pid" ]]; then kill "$monitor_pid" 2>/dev/null || true; fi
  if [[ -n "$api_pid" ]]; then kill -TERM "$api_pid" 2>/dev/null || true; wait "$api_pid" || true; fi
  docker logs "$container_name" > "$run_dir/postgres.log" 2>&1 || true
  docker rm -f -v "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cd "$repo_dir"
if [[ -n "${LOADTEST_BINARY:-}" ]]; then
  test -x "$LOADTEST_BINARY"
  cp "$LOADTEST_BINARY" "$run_dir/loadtest"
else
  go build -o "$run_dir/loadtest" ./cmd/loadtest
fi
shasum -a 256 "$run_dir/loadtest" > "$run_dir/binary-sha256.txt"
go version -m "$run_dir/loadtest" > "$run_dir/binary-build.txt"
test_password="$(openssl rand -hex 16)"
docker run --detach --name "$container_name" --cpus=2 --memory=1g \
  --publish 127.0.0.1::5432 -e POSTGRES_DB=infinite_canvas_test \
  -e POSTGRES_USER=loadtest -e "POSTGRES_PASSWORD=$test_password" \
  postgres:17-alpine -c shared_preload_libraries=pg_stat_statements -c track_io_timing=on \
  -c log_min_duration_statement=200 -c log_lock_waits=on -c deadlock_timeout=100ms > "$run_dir/container-id"
for attempt in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U loadtest -d infinite_canvas_test >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container_name" psql -U loadtest -d infinite_canvas_test -c 'CREATE EXTENSION pg_stat_statements;'
db_port="$(docker port "$container_name" 5432 | awk -F: '{print $NF}')"
export TEST_DATABASE_DSN="postgres://loadtest:$test_password@127.0.0.1:$db_port/infinite_canvas_test?sslmode=disable"
GOMAXPROCS=4 "$run_dir/loadtest" -mode server -manifest "$run_dir/manifest.json" -out "$run_dir/server" > "$run_dir/server-start.log" 2>&1 &
api_pid=$!
for attempt in $(seq 1 120); do
  [[ -f "$run_dir/manifest.json" ]] && break
  kill -0 "$api_pid" 2>/dev/null || { cat "$run_dir/server-start.log"; exit 1; }
  sleep 1
done
test -f "$run_dir/manifest.json"
python3 scripts/loadtest/monitor.py --manifest "$run_dir/manifest.json" --container "$container_name" --out "$run_dir/resources.ndjson" &
monitor_pid=$!
git rev-parse HEAD > "$run_dir/baseline.txt"
docker info --format '{{json .NCPU}} {{json .MemTotal}}' > "$run_dir/docker-resources.txt"
result=0
python3 scripts/loadtest/database-snapshot.py "$container_name" "$run_dir/database-before.json"
for users in "${user_stages[@]}"; do
  "$run_dir/loadtest" -mode client -manifest "$run_dir/manifest.json" -out "$run_dir/$users" -users "$users" -ramp 30s -hold 180s -down 30s || result=1
done
python3 scripts/loadtest/database-snapshot.py "$container_name" "$run_dir/database-after.json"
python3 scripts/loadtest/finish.py "$run_dir" "$container_name" || result=1
python3 scripts/loadtest/summarize.py "$run_dir"
echo "Load test artifacts: $run_dir"
exit "$result"
