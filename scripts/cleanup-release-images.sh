#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-state.sh"

cleanup_release_images() {
  local mode=${1:---dry-run} target=${2:-} protected='|' containers container id ref images candidates='' current_id previous_id
  [[ $mode == --dry-run || $mode == --apply ]] || { echo 'usage: cleanup-release-images.sh [--dry-run|--apply]' >&2; return 64; }
  read_state || { echo 'cleanup skipped: invalid release state' >&2; return 1; }
  [[ -n $PREVIOUS_IMAGE ]] || { echo 'cleanup skipped: two distinct healthy releases are required'; return 0; }
  target=${target:-$LAST_GOOD_IMAGE}
  [[ $target == "$LAST_GOOD_IMAGE" ]] || return 1
  # Resolve all protected image IDs before deleting anything; alias tags share protection.
  current_id=$(docker image inspect --format '{{.Id}}' "$LAST_GOOD_IMAGE") || return 1
  previous_id=$(docker image inspect --format '{{.Id}}' "$PREVIOUS_IMAGE") || return 1
  [[ -n $current_id && -n $previous_id ]] || return 1
  protected+="$current_id|$previous_id|"
  containers=$(docker ps -aq) || return 1
  for container in $containers; do
    id=$(docker inspect --format '{{.Image}}' "$container") || return 1
    [[ -n $id ]] || return 1
    protected+="$id|"
  done
  images=$(docker image ls --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}') || return 1
  while read -r ref id; do
    [[ $ref =~ ^ghcr\.io/dijia1/infinite-canvas:sha-[0-9a-f]{40}$ ]] || continue
    [[ -n $id ]] || return 1
    [[ $protected != *"|$id|"* ]] || continue
    candidates+="$ref $id"$'\n'
  done <<< "$images"
  while read -r ref id; do
    [[ -n $ref ]] || continue
    echo "$mode historical image: $ref ($id)"
    [[ $mode == --apply ]] || continue
    # Recheck tag and every container immediately before removal (including stopped).
    [[ $(docker image inspect --format '{{.Id}}' "$ref") == "$id" ]] || return 1
    containers=$(docker ps -aq) || return 1
    local in_use=false referenced_id
    for container in $containers; do
      referenced_id=$(docker inspect --format '{{.Image}}' "$container") || return 1
      [[ -n $referenced_id ]] || return 1
      if [[ $referenced_id == "$id" ]]; then in_use=true; fi
    done
    [[ $in_use == false ]] || continue
    docker image rm "$ref" || return 1
  done <<< "$candidates"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  [[ -d $STATE_DIR ]] || { echo 'release state directory is missing' >&2; exit 66; }
  exec 9>"$LOCK_FILE"
  flock -n 9 || { echo 'another deployment or cleanup is running' >&2; exit 75; }
  cleanup_release_images "${1:---dry-run}"
fi
