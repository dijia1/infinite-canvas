#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
compose=(docker compose -f docker-compose.local.yml)

# Startup only checks connectivity. Apply the new image's schema before replacing app.
"${compose[@]}" build app
"${compose[@]}" run --rm --no-deps app /app/migrate
"${compose[@]}" up -d --no-deps app
