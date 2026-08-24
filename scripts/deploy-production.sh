#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_SHA=${1:?missing deploy SHA}
TARGET_IMAGE=${2:?missing target image}
RELEASE_DIR=${3:?missing release directory}
APP_DIR=${INFINITE_CANVAS_APP_DIR:-/program/apps/infinite-canvas}
STATE_DIR=${INFINITE_CANVAS_RELEASE_STATE_DIR:-/program/data/infinite-canvas}
MEDIA_DIR=${INFINITE_CANVAS_MEDIA_DIR:-/program/data/infinite-canvas/media}
ENV_FILE="$APP_DIR/.env"
STATE_FILE="$STATE_DIR/infinite-canvas-release.last-known-good"
LOCK_FILE="$STATE_DIR/infinite-canvas-release.lock"

[[ $DEPLOY_SHA =~ ^[0-9a-f]{40}$ ]] || { echo "invalid deploy SHA" >&2; exit 64; }
[[ $TARGET_IMAGE =~ ^ghcr\.io/dijia1/infinite-canvas:sha-[0-9a-f]{40}$ ]] || { echo "invalid image reference" >&2; exit 64; }
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

services_healthy() {
  local release_dir=$1
  local image=$2
  local container
  container=$(compose "$release_dir" "$image" ps --status running -q app)
  [[ -n $container ]] || return 1
  [[ $(docker inspect --format '{{.State.Health.Status}}' "$container") == healthy ]]
}

wait_for_healthy() {
  local release_dir=$1
  local image=$2
  local attempt
  for ((attempt = 1; attempt <= 30; attempt++)); do
    if services_healthy "$release_dir" "$image"; then
      return 0
    fi
    if (( attempt < 30 )); then
      sleep 2
    fi
  done
  return 1
}

read_state() {
  [[ -f $STATE_FILE ]] || return 1
  local extra
  LAST_GOOD_SHA=$(sed -n 's/^git_sha=//p' "$STATE_FILE")
  LAST_GOOD_IMAGE=$(sed -n 's/^image_ref=//p' "$STATE_FILE")
  LAST_GOOD_RELEASE=$(sed -n 's/^release_dir=//p' "$STATE_FILE")
  extra=$(grep -Ev '^(git_sha|image_ref|release_dir)=' "$STATE_FILE" || true)
  [[ -z $extra && $LAST_GOOD_SHA =~ ^[0-9a-f]{40}$ && $LAST_GOOD_IMAGE =~ ^ghcr\.io/dijia1/infinite-canvas:sha-[0-9a-f]{40}$ && $LAST_GOOD_RELEASE == "$APP_DIR/releases/$LAST_GOOD_SHA" && -f "$LAST_GOOD_RELEASE/docker-compose.yml" ]]
}

write_state() {
  local file
  file=$(mktemp "$STATE_DIR/.infinite-canvas-release.XXXXXX")
  chmod 600 "$file"
  printf 'git_sha=%s\nimage_ref=%s\nrelease_dir=%s\n' "$1" "$2" "$3" > "$file"
  mv "$file" "$STATE_FILE"
}

rollback() {
  echo "target deployment failed; restoring $LAST_GOOD_SHA" >&2
  docker pull "$LAST_GOOD_IMAGE"
  compose "$LAST_GOOD_RELEASE" "$LAST_GOOD_IMAGE" config -q
  compose "$LAST_GOOD_RELEASE" "$LAST_GOOD_IMAGE" up -d --no-build --force-recreate app
  wait_for_healthy "$LAST_GOOD_RELEASE" "$LAST_GOOD_IMAGE"
}

initialize_release_state() {
  local initialize_sha=${1:?missing deploy SHA}
  local initialize_image=${2:?missing target image}
  local initialize_release=${3:?missing release directory}
  [[ $initialize_sha =~ ^[0-9a-f]{40}$ ]] || { echo "invalid deploy SHA" >&2; exit 64; }
  [[ $initialize_image =~ ^ghcr\.io/dijia1/infinite-canvas:sha-[0-9a-f]{40}$ ]] || { echo "invalid image reference" >&2; exit 64; }
  [[ $initialize_release == "$APP_DIR/releases/$initialize_sha" && -f "$initialize_release/docker-compose.yml" && -f "$ENV_FILE" ]] || { echo "invalid initial release" >&2; exit 64; }
  mkdir -p "$STATE_DIR" "$MEDIA_DIR"
  exec 9>"$LOCK_FILE"
  flock -n 9 || { echo "another deployment is running" >&2; exit 75; }
  [[ ! -f $STATE_FILE ]] || { echo "last-known-good state already exists" >&2; exit 65; }
  wait_for_healthy "$initialize_release" "$initialize_image" || { echo "initial release is not healthy" >&2; exit 69; }
  write_state "$initialize_sha" "$initialize_image" "$initialize_release"
}

main() {
  read_state || { echo "no valid last-known-good release; run initialize-release-state.sh after a controlled first release" >&2; exit 69; }
  services_healthy "$LAST_GOOD_RELEASE" "$LAST_GOOD_IMAGE" || { echo "current release is not healthy; refusing deployment" >&2; exit 69; }
  docker pull "$TARGET_IMAGE"
  docker image inspect "$LAST_GOOD_IMAGE" >/dev/null 2>&1 || docker pull "$LAST_GOOD_IMAGE"

  if ! (
    compose "$RELEASE_DIR" "$TARGET_IMAGE" config -q &&
      compose "$RELEASE_DIR" "$TARGET_IMAGE" up -d --no-build --force-recreate app &&
      wait_for_healthy "$RELEASE_DIR" "$TARGET_IMAGE" &&
      write_state "$DEPLOY_SHA" "$TARGET_IMAGE" "$RELEASE_DIR"
  ); then
    rollback || echo "rollback failed" >&2
    exit 1
  fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main
fi
