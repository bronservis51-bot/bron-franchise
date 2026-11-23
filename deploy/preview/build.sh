#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 || ! "$1" =~ ^[0-9a-f]{40}$ || ! "$2" = /* ]]; then
  printf 'Usage: bash deploy/preview/build.sh <source-commit> <absolute-output.tar.gz>\n' >&2
  exit 64
fi
source_commit=$1
output=$2
origin=https://preview.152-228-115-115.sslip.io
if [[ "$(git rev-parse HEAD)" != "$source_commit" ]] || ! git diff --quiet || ! git diff --cached --quiet; then
  printf 'Use a clean checkout of the chosen source commit.\n' >&2
  exit 65
fi

npm ci --prefer-offline
VITE_BASE_PATH=/ VITE_APP_ENV=staging VITE_SUPABASE_URL=$origin VITE_GOOGLE_DRIVE_CLIENT_ID= \
  VITE_SUPABASE_PUBLISHABLE_KEY=bron_staging_public_client_only npm run build

workspace=$(mktemp -d)
trap 'rm -rf -- "$workspace"' EXIT
mkdir -p "$workspace/backend/scripts" "$workspace/backend/node_modules/@electric-sql" "$workspace/ops"
cp -r dist "$workspace/site"
cp -r supabase "$workspace/backend/"
cp scripts/local-backend.mjs scripts/db-lib.mjs "$workspace/backend/scripts/"
cp -rL node_modules/@electric-sql/pglite "$workspace/backend/node_modules/@electric-sql/"
cp deploy/preview/{gate.mjs,Caddyfile,bron-mobile-preview-api.service,bron-mobile-preview-gate.service} "$workspace/ops/"
printf '%s\n' "$source_commit" > "$workspace/source-commit"
printf '{"sourceCommit":"%s","environment":"staging"}\n' "$source_commit" > "$workspace/site/preview-version.json"
tar -C "$workspace" -czf "$output" backend ops site source-commit
sha256sum "$output"
