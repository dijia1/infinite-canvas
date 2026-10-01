#!/usr/bin/env bash
# Shared validation for deployment and local image cleanup. Never source state as code.
APP_DIR=${INFINITE_CANVAS_APP_DIR:-/program/apps/infinite-canvas}
STATE_DIR=${INFINITE_CANVAS_RELEASE_STATE_DIR:-/program/data/infinite-canvas}
STATE_FILE="$STATE_DIR/infinite-canvas-release.last-known-good"
LOCK_FILE="$STATE_DIR/infinite-canvas-release.lock"
IMAGE_REPOSITORY=ghcr.io/dijia1/infinite-canvas

valid_release() {
  [[ $1 =~ ^[0-9a-f]{40}$ && $2 == "$IMAGE_REPOSITORY:sha-$1" && $3 == "$APP_DIR/releases/$1" && -f "$3/docker-compose.yml" ]] || return 1
  [[ $(git -C "$3" rev-parse HEAD 2>/dev/null) == "$1" ]] || return 1
  git -C "$3" diff --quiet && git -C "$3" diff --cached --quiet
}

read_state() {
  [[ -f $STATE_FILE ]] || return 1
  local key value seen='|' version='' legacy_sha='' legacy_image='' legacy_release=''
  LAST_GOOD_SHA='' LAST_GOOD_IMAGE='' LAST_GOOD_RELEASE=''
  PREVIOUS_SHA='' PREVIOUS_IMAGE='' PREVIOUS_RELEASE=''
  while IFS='=' read -r key value || [[ -n $key ]]; do
    [[ $seen != *"|$key|"* ]] || return 1
    seen+="$key|"
    case "$key" in
      version) version=$value ;;
      git_sha) legacy_sha=$value ;;
      image_ref) legacy_image=$value ;;
      release_dir) legacy_release=$value ;;
      current_sha) LAST_GOOD_SHA=$value ;;
      current_image) LAST_GOOD_IMAGE=$value ;;
      current_release) LAST_GOOD_RELEASE=$value ;;
      previous_sha) PREVIOUS_SHA=$value ;;
      previous_image) PREVIOUS_IMAGE=$value ;;
      previous_release) PREVIOUS_RELEASE=$value ;;
      *) return 1 ;;
    esac
  done < "$STATE_FILE"
  if [[ -z $version ]]; then
    [[ $seen == '|git_sha|image_ref|release_dir|' ]] || return 1
    LAST_GOOD_SHA=$legacy_sha LAST_GOOD_IMAGE=$legacy_image LAST_GOOD_RELEASE=$legacy_release
  else
    [[ $version == 2 && $seen == '|version|current_sha|current_image|current_release|previous_sha|previous_image|previous_release|' ]] || return 1
    if [[ -n $PREVIOUS_SHA || -n $PREVIOUS_IMAGE || -n $PREVIOUS_RELEASE ]]; then
      valid_release "$PREVIOUS_SHA" "$PREVIOUS_IMAGE" "$PREVIOUS_RELEASE" || return 1
      [[ $PREVIOUS_SHA != "$LAST_GOOD_SHA" ]] || return 1
    fi
  fi
  valid_release "$LAST_GOOD_SHA" "$LAST_GOOD_IMAGE" "$LAST_GOOD_RELEASE"
}

write_state() {
  local file previous_sha=${PREVIOUS_SHA:-} previous_image=${PREVIOUS_IMAGE:-} previous_release=${PREVIOUS_RELEASE:-}
  if [[ -n ${LAST_GOOD_SHA:-} && $1 != "$LAST_GOOD_SHA" ]]; then
    previous_sha=$LAST_GOOD_SHA previous_image=$LAST_GOOD_IMAGE previous_release=$LAST_GOOD_RELEASE
  fi
  file=$(mktemp "$STATE_DIR/.infinite-canvas-release.XXXXXX") || return 1
  if ! { chmod 600 "$file" && printf 'version=2\ncurrent_sha=%s\ncurrent_image=%s\ncurrent_release=%s\nprevious_sha=%s\nprevious_image=%s\nprevious_release=%s\n' "$1" "$2" "$3" "$previous_sha" "$previous_image" "$previous_release" > "$file" && mv "$file" "$STATE_FILE"; }; then
    rm -f "$file"
    return 1
  fi
}
