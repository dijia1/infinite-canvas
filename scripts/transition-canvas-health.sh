#!/usr/bin/env bash
# Manual one-time fixed-SHA transition. Never invoked by the normal CI workflow.
# --apply is an operation mode, not authorization; explicit user approval is
# required externally. Default --plan performs no app/env/Docker reads or writes.
set -Eeuo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LEGACY_SHA=731a00ad08b90a10403df974d78c433e3e6db887
HEALTH_SHA=af2f6be3d2c6d2f00565a9711b6e2543ea14ec99
GATEWAY_HEALTH_URL=https://www.semetaloa.com/apps/infinite-canvas/api/healthz
mode=${1:---plan}
if [[ $mode == --plan ]]; then
  printf 'Plan only: fixed legacy %s -> auth/JSON-health %s; then ordinary strict lifecycle deployment.\n' "$LEGACY_SHA" "$HEALTH_SHA"
  printf 'Requires genuine Git release metadata, private verified schema backup/restore receipt and unchanged legacy state. No production action performed.\n'
  exit 0
fi
[[ $mode == --check || $mode == --apply ]] || { echo 'Use --plan, --check or --apply <backup-receipt>.' >&2; exit 64; }
RECEIPT=${2:?missing verified backup receipt}
[[ $# == 2 ]] || exit 64
source "$SCRIPT_DIR/release-state.sh"
MEDIA_DIR=${INFINITE_CANVAS_MEDIA_DIR:-/program/data/infinite-canvas/media}
ENV_FILE="$APP_DIR/.env"
TARGET_IMAGE="$IMAGE_REPOSITORY:sha-$HEALTH_SHA"
TARGET_RELEASE="$APP_DIR/releases/$HEALTH_SHA"
legacy_image="$IMAGE_REPOSITORY:sha-$LEGACY_SHA"
legacy_release="$APP_DIR/releases/$LEGACY_SHA"
health_attempts=${DEPLOY_HEALTH_ATTEMPTS:-90}
health_interval=${DEPLOY_HEALTH_INTERVAL:-2}
[[ $health_attempts =~ ^[1-9][0-9]*$ && $health_interval =~ ^[0-9]+$ ]] || exit 64
# No directory/mount permission or network setup here. Prerequisites must be prepared by an
# explicitly approved operator; --check does not create even the deployment lock.
[[ -d $STATE_DIR && -d $MEDIA_DIR && -f $ENV_FILE && -f $STATE_FILE ]] || { echo 'Existing application prerequisites missing.' >&2; exit 66; }
compose() {
  local release=$1 image=$2; shift 2
  INFINITE_CANVAS_IMAGE="$image" INFINITE_CANVAS_ENV_FILE="$ENV_FILE" INFINITE_CANVAS_MEDIA_DIR="$MEDIA_DIR" \
    docker compose --project-name infinite-canvas --env-file "$ENV_FILE" -f "$release/docker-compose.yml" "$@"
}
container_for() {
  local release=$1 image=$2 rev=$3 container actual_id expected_id
  container=$(compose "$release" "$image" ps --all -q app) || return 1
  [[ -n $container && $container != *$'\n'* ]] || return 1
  expected_id=$(docker image inspect --format '{{.Id}}' "$image") || return 1
  actual_id=$(docker inspect --format '{{.Image}}' "$container") || return 1
  [[ $actual_id == "$expected_id" ]] || return 1
  [[ $(docker inspect --format '{{.Config.Image}}' "$container") == "$image" ]] || return 1
  [[ $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image") == "$rev" ]] || return 1
  [[ $(docker inspect --format '{{.State.Status}} {{.State.Health.Status}} {{.State.OOMKilled}}' "$container") == 'running healthy false' ]] || return 1
  printf '%s\n' "$container"
}
legacy_healthy() {
  local container
  container=$(container_for "$legacy_release" "$legacy_image" "$LEGACY_SHA") || return 1
  docker exec -i "$container" node --input-type=module - "$GATEWAY_HEALTH_URL" "$LEGACY_SHA" < "$SCRIPT_DIR/check-legacy-canvas-health.mjs"
}
strict_healthy() {
  local container
  container=$(container_for "$TARGET_RELEASE" "$TARGET_IMAGE" "$HEALTH_SHA") || return 1
  docker exec -i "$container" node --input-type=module - "$GATEWAY_HEALTH_URL" --gateway < "$SCRIPT_DIR/check-gateway-health.mjs"
}
wait_healthy() {
  local check=$1 attempt deadline=$((SECONDS+180))
  for ((attempt=1; attempt<=health_attempts; attempt++)); do
    "$check" && return 0
    (( SECONDS < deadline )) || return 1
    (( attempt == health_attempts )) || sleep "$health_interval"
  done
  return 1
}
preflight() {
  # Python3 was verified present on the existing host; no host Node install.
  python3 "$SCRIPT_DIR/check-canvas-backup-receipt.py" "$RECEIPT" "$STATE_DIR" || return 1
  valid_release "$HEALTH_SHA" "$TARGET_IMAGE" "$TARGET_RELEASE" || { echo 'Target lacks genuine clean Git metadata.' >&2; return 1; }
  read_state || { echo 'Current/previous release metadata is invalid; prepare real Git checkouts first.' >&2; return 1; }
  [[ $LAST_GOOD_SHA == "$LEGACY_SHA" && $LAST_GOOD_IMAGE == "$legacy_image" && $LAST_GOOD_RELEASE == "$legacy_release" ]] || { echo 'Fixed legacy baseline is no longer current; transition refused.' >&2; return 1; }
  compose "$legacy_release" "$legacy_image" config -q || return 1
  compose "$TARGET_RELEASE" "$TARGET_IMAGE" config -q || return 1
  legacy_healthy || { echo 'Old-contract baseline is not actually healthy.' >&2; return 1; }
}
if [[ $mode == --check ]]; then
  preflight
  echo 'Read-only readiness verified under the legacy contract; no JSON baseline recorded.'
  exit 0
fi
exec 9>>"$LOCK_FILE"
flock -n 9 || { echo 'Another deployment holds the application lock.' >&2; exit 75; }
preflight || exit 69
state_before=$(git hash-object --no-filters -- "$STATE_FILE")
switched=false
failure() {
  trap - ERR
  trap '' INT TERM
  if [[ $switched == true ]]; then
    echo 'Transition failed; restoring exact legacy image/config without rewriting healthy state.' >&2
    if compose "$legacy_release" "$legacy_image" up -d --no-build --force-recreate app && wait_healthy legacy_healthy; then
      echo 'Legacy version recovered under its real old contract; it is not a JSON baseline.' >&2
    else
      echo 'Legacy recovery FAILED; operator intervention required.' >&2
    fi
  fi
  [[ $(git hash-object --no-filters -- "$STATE_FILE" 2>/dev/null || true) == "$state_before" ]] || echo 'Release state changed unexpectedly; refusing to overwrite it.' >&2
  exit 1
}
trap failure ERR INT TERM
docker pull "$TARGET_IMAGE"
[[ $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$TARGET_IMAGE") == "$HEALTH_SHA" ]] || failure
[[ $(git hash-object --no-filters -- "$STATE_FILE") == "$state_before" ]] || failure
switched=true
# This prerequisite image retains its existing startup migrations; it has no
# /app/migrate. Verified restore evidence is required before this controlled up.
compose "$TARGET_RELEASE" "$TARGET_IMAGE" up -d --no-build --force-recreate app
wait_healthy strict_healthy
[[ $(git hash-object --no-filters -- "$STATE_FILE") == "$state_before" ]] || failure
# Do not interrupt the tiny atomic state publication once strict health passed.
trap '' INT TERM
if write_state "$HEALTH_SHA" "$TARGET_IMAGE" "$TARGET_RELEASE"; then
  trap - ERR INT TERM
  echo 'Real JSON health verified; current/previous state published atomically. Historical images retained.'
else
  failure
fi
