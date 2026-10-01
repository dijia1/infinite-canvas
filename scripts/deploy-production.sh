#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_SHA=${1:?missing deploy SHA}
TARGET_IMAGE=${2:?missing target image}
RELEASE_DIR=${3:?missing release directory}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/release-state.sh"
MEDIA_DIR=${INFINITE_CANVAS_MEDIA_DIR:-/program/data/infinite-canvas/media}
ENV_FILE="$APP_DIR/.env"
GATEWAY_HEALTH_URL=${INFINITE_CANVAS_GATEWAY_HEALTH_URL:-https://www.semetaloa.com/apps/infinite-canvas/api/healthz}

[[ $DEPLOY_SHA =~ ^[0-9a-f]{40}$ ]] || { echo "invalid deploy SHA" >&2; exit 64; }
[[ $TARGET_IMAGE =~ ^ghcr\.io/dijia1/infinite-canvas:sha-[0-9a-f]{40}$ ]] || { echo "invalid image reference" >&2; exit 64; }
[[ $TARGET_IMAGE == "$IMAGE_REPOSITORY:sha-$DEPLOY_SHA" ]] || { echo "image SHA does not match deploy SHA" >&2; exit 64; }
[[ $RELEASE_DIR == "$APP_DIR/releases/$DEPLOY_SHA" ]] || { echo "invalid release directory" >&2; exit 64; }
[[ -f "$RELEASE_DIR/docker-compose.yml" ]] || { echo "release compose file is missing" >&2; exit 66; }
[[ -f "$ENV_FILE" ]] || { echo "production .env is missing" >&2; exit 66; }

mkdir -p "$STATE_DIR" "$MEDIA_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "another deployment is running" >&2; exit 75; }

compose() {
  local release_dir=$1
  local image=$2
  shift 2
  INFINITE_CANVAS_IMAGE="$image" \
    INFINITE_CANVAS_ENV_FILE="$ENV_FILE" \
    INFINITE_CANVAS_MEDIA_DIR="$MEDIA_DIR" \
    docker compose --project-name infinite-canvas --env-file "$ENV_FILE" -f "$release_dir/docker-compose.yml" "$@"
}

release_container() {
  local release_dir=$1
  local image=$2
  local container
  container=$(compose "$release_dir" "$image" ps --all -q app) || return 1
  [[ -n $container ]] || return 1
  [[ $container != *$'\n'* ]] || return 1
  local expected_id actual_id actual_ref
  expected_id=$(docker image inspect --format '{{.Id}}' "$image") || return 1
  actual_id=$(docker inspect --format '{{.Image}}' "$container") || return 1
  actual_ref=$(docker inspect --format '{{.Config.Image}}' "$container") || return 1
  [[ -n $expected_id && $actual_id == "$expected_id" && $actual_ref == "$image" ]] || return 1
  printf '%s\n' "$container"
}

services_healthy() {
  local container
  container=$(release_container "$1" "$2") || return 1
  [[ $(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container") == 'running healthy' ]]
}

# A healthy container alone does not validate the Portal registry, DNS or public route.
# No session, credentials or redirects: only the exact public health contract counts.
gateway_healthy() {
  local container
  container=$(release_container "$1" "$2") || return 1
  docker exec -i "$container" node --input-type=module - "$GATEWAY_HEALTH_URL" --gateway < "$SCRIPT_DIR/check-gateway-health.mjs"
}

wait_for_healthy() {
  local release_dir=$1
  local image=$2
  local attempts=${DEPLOY_HEALTH_ATTEMPTS:-90} interval=${DEPLOY_HEALTH_INTERVAL:-2}
  [[ $attempts =~ ^[1-9][0-9]*$ && $interval =~ ^[0-9]+$ ]] || return 1
  local attempt deadline=$((SECONDS + 180))
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if services_healthy "$release_dir" "$image" && gateway_healthy "$release_dir" "$image"; then
      return 0
    fi
    if (( SECONDS >= deadline )); then return 1; fi
    if (( attempt < attempts )); then
      sleep "$interval"
    fi
  done
  return 1
}

rollback() {
  echo "target deployment failed; restoring $LAST_GOOD_SHA" >&2
  docker pull "$LAST_GOOD_IMAGE" &&
  compose "$LAST_GOOD_RELEASE" "$LAST_GOOD_IMAGE" config -q &&
  compose "$LAST_GOOD_RELEASE" "$LAST_GOOD_IMAGE" up -d --no-build --force-recreate app &&
  wait_for_healthy "$LAST_GOOD_RELEASE" "$LAST_GOOD_IMAGE"
}

initialize_release_state() {
  local initialize_sha=${1:?missing deploy SHA}
  local initialize_image=${2:?missing target image}
  local initialize_release=${3:?missing release directory}
  [[ $initialize_sha =~ ^[0-9a-f]{40}$ ]] || { echo "invalid deploy SHA" >&2; exit 64; }
  [[ $initialize_image =~ ^ghcr\.io/dijia1/infinite-canvas:sha-[0-9a-f]{40}$ ]] || { echo "invalid image reference" >&2; exit 64; }
  [[ $initialize_release == "$APP_DIR/releases/$initialize_sha" && -f "$initialize_release/docker-compose.yml" && -f "$ENV_FILE" ]] || { echo "invalid initial release" >&2; exit 64; }
  valid_release "$initialize_sha" "$initialize_image" "$initialize_release" || exit 64
  [[ ! -f $STATE_FILE ]] || { echo "last-known-good state already exists" >&2; exit 65; }
  compose "$initialize_release" "$initialize_image" config -q || exit 69
  wait_for_healthy "$initialize_release" "$initialize_image" || { echo "initial release is not healthy" >&2; exit 69; }
  write_state "$initialize_sha" "$initialize_image" "$initialize_release"
}

main() {
  valid_release "$DEPLOY_SHA" "$TARGET_IMAGE" "$RELEASE_DIR" || { echo "target commit is unavailable or release checkout is dirty" >&2; exit 66; }
  read_state || { echo "no valid last-known-good release; initialize after a controlled first release" >&2; exit 69; }
  compose "$LAST_GOOD_RELEASE" "$LAST_GOOD_IMAGE" config -q || exit 69
  services_healthy "$LAST_GOOD_RELEASE" "$LAST_GOOD_IMAGE" && gateway_healthy "$LAST_GOOD_RELEASE" "$LAST_GOOD_IMAGE" || {
    echo "current release or Gateway is unhealthy; refusing deployment" >&2; exit 69;
  }
  if ! (
    docker pull "$TARGET_IMAGE" &&
      compose "$RELEASE_DIR" "$TARGET_IMAGE" config -q &&
      compose "$RELEASE_DIR" "$TARGET_IMAGE" run --rm --no-deps app /app/migrate &&
      compose "$RELEASE_DIR" "$TARGET_IMAGE" up -d --no-build --force-recreate app &&
      wait_for_healthy "$RELEASE_DIR" "$TARGET_IMAGE" &&
      write_state "$DEPLOY_SHA" "$TARGET_IMAGE" "$RELEASE_DIR"
  ); then
    rollback || echo "rollback failed; manual intervention required" >&2
    exit 1
  fi
  source "$SCRIPT_DIR/cleanup-release-images.sh"
  cleanup_release_images --apply "$TARGET_IMAGE" || echo "warning: historical image cleanup failed; healthy release retained" >&2
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main
fi
