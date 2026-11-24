#!/usr/bin/env bash
# Run on the Timeweb VPS from its pinned administrative SSH connection.
set -euo pipefail
umask 077
if [[ $(id -u) != 0 || $# != 2 || ! "$1" = /* || ! "$2" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'Usage: install.sh <absolute-preview-bundle> <sha256>\n' >&2
  exit 64
fi
printf '%s  %s\n' "$2" "$1" | sha256sum --check --strict --status

root=/opt/bron-mobile-preview
private=/etc/bron-mobile-preview
state=/var/lib/bron-mobile-preview
web=/opt/bron/supabase/docker/bron/site
caddy=/opt/bron/supabase/docker/bron/Caddyfile
front=supabase-web-1
public_origin=https://preview.152-228-115-115.sslip.io

install -d -m 0755 "$root" "$root/releases" "$root/runtime" "$web/.mobile-preview-releases"
install -d -m 0700 "$private" "$state"
if ! id -u bron-preview >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin bron-preview
fi
chown bron-preview:bron-preview "$state"
exec 9>"$private/install.lock"
flock -n 9
if [[ ! -x "$root/runtime/node" ]]; then
  install -m 0755 /opt/bron/node-v22.23.5-linux-x64/bin/node "$root/runtime/node"
fi

temporary=$(mktemp -d "$root/releases/.incoming.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT
tar --extract --gzip --file "$1" --directory "$temporary" --no-same-owner --no-same-permissions
version=$(cat "$temporary/source-commit")
[[ "$version" =~ ^[0-9a-f]{40}$ && -f "$temporary/site/sw.js" && -f "$temporary/backend/scripts/local-backend.mjs" ]]
if [[ -e "$root/releases/$version" || -e "$web/.mobile-preview-releases/$version" ]]; then
  printf 'Preview release already exists.\n' >&2
  exit 65
fi
release="$root/releases/$version"
install -d -o bron-preview -g bron-preview -m 0700 "$state/$version"
ln -s "$state/$version" "$temporary/backend/local"
chmod 0755 "$temporary"
find "$temporary/backend" "$temporary/ops" -type d -exec chmod 0755 '{}' +
find "$temporary/backend" "$temporary/ops" -type f -exec chmod 0644 '{}' +
mv -- "$temporary/site" "$web/.mobile-preview-releases/$version"
find "$web/.mobile-preview-releases/$version" -type d -exec chmod 0755 '{}' +
find "$web/.mobile-preview-releases/$version" -type f -exec chmod 0644 '{}' +
mv -- "$temporary" "$release"

python3 - "$private" "$public_origin" <<'PY'
from pathlib import Path
from secrets import token_urlsafe
import sys
root = Path(sys.argv[1])
def write_once(name, text):
    path = root / name
    if not path.exists():
        with path.open('x', encoding='ascii') as f:
            f.write(text)
write_once('gate.env', 'BRON_PREVIEW_ORIGIN=' + sys.argv[2] + '\n')
write_once('api.env', 'BRON_STAGING_ACCOUNT_PASSWORD=' + token_urlsafe(18) + '\n')
PY

prior_source=$(readlink "$root/current" || true)
prior_site=$(readlink "$web/mobile-preview" || true)

# Replace only the managed preview block and keep the bind-mounted file inode.
backup=$(mktemp "$private/caddy-before.XXXXXX")
candidate=$(mktemp "$private/caddy-candidate.XXXXXX")
cat "$caddy" > "$backup"
python3 - "$backup" "$release/ops/Caddyfile" "$candidate" <<'PY'
import re
import sys
from pathlib import Path

previous, preview, output = map(Path, sys.argv[1:])
active = previous.read_bytes()
updated = preview.read_bytes()
block = re.compile(rb'^# BEGIN BRON MOBILE PREVIEW\n.*?^# END BRON MOBILE PREVIEW\n?', re.MULTILINE | re.DOTALL)
if not block.fullmatch(updated):
    raise SystemExit('Invalid managed preview block')
if active.count(b'# BEGIN BRON MOBILE PREVIEW') == active.count(b'# END BRON MOBILE PREVIEW') == 0:
    output.write_bytes(active + b'\n' + updated)
elif active.count(b'# BEGIN BRON MOBILE PREVIEW') == active.count(b'# END BRON MOBILE PREVIEW') == 1:
    result, count = block.subn(lambda _: updated, active)
    if count != 1:
        raise SystemExit('Could not replace the managed preview block')
    output.write_bytes(result)
else:
    raise SystemExit('Ambiguous managed preview block')
PY
if ! cmp -s "$backup" "$candidate"; then
  docker cp "$candidate" "$front:/tmp/bron-mobile-preview.Caddyfile"
  docker exec "$front" caddy validate --config /tmp/bron-mobile-preview.Caddyfile --adapter caddyfile
fi

if [[ ${BRON_PREVIEW_PRESERVE_DATA:-0} == 1 ]]; then
  [[ "$prior_source" == "$root/releases/"* && "${prior_source##*/}" =~ ^[0-9a-f]{40}$ ]]
  prior_data=$(readlink -e "$prior_source/backend/local")
  [[ "$prior_data" == "$state/"* && "${prior_data##*/}" =~ ^[0-9a-f]{40}$ ]]
  diff -qr "$prior_source/backend/supabase/migrations" "$release/backend/supabase/migrations"
  systemctl stop bron-mobile-preview-api.service
  if ! cp -a --reflink=auto "$prior_data/." "$state/$version/" ||
     ! systemd-run --wait --collect --pipe --quiet --uid=bron-preview --gid=bron-preview \
        --property=EnvironmentFile="$private/api.env" --setenv=BRON_STAGING_REQUIRED=1 \
        --property=WorkingDirectory="$release/backend" --property=InaccessiblePaths=/opt/bron \
        "$root/runtime/node" scripts/local-backend.mjs --rotate-staging-logins; then
    systemctl start bron-mobile-preview-api.service
    printf 'Could not prepare the preserved preview data.\n' >&2
    exit 1
  fi
fi

switch_link() {
  local target=$1 name=$2
  ln -s -- "$target" "$name.next"
  mv -T -- "$name.next" "$name"
}
switch_link "$release" "$root/current"
restore() {
  if [[ -n "$prior_source" ]]; then
    switch_link "$prior_source" "$root/current"
    systemctl restart bron-mobile-preview-api.service bron-mobile-preview-gate.service
  else
    systemctl stop bron-mobile-preview-api.service bron-mobile-preview-gate.service
    rm -- "$root/current"
  fi
  if [[ -n "$prior_site" ]]; then
    switch_link "$prior_site" "$web/mobile-preview"
  elif [[ -L "$web/mobile-preview" ]]; then
    rm -- "$web/mobile-preview"
  fi
}
install -m 0644 "$release"/ops/*.service /etc/systemd/system/
systemctl daemon-reload
if ! systemctl restart bron-mobile-preview-api.service bron-mobile-preview-gate.service ||
   ! curl -fsS --retry 15 --retry-connrefused --retry-delay 2 --max-time 3 http://127.0.0.1:54982/auth/v1/health >/dev/null ||
   ! docker exec "$front" curl -fsS --max-time 3 http://172.19.0.1:54981/auth/v1/health >/dev/null ||
   [[ "$(docker exec "$front" curl -sS -o /dev/null -w '%{http_code}' --max-time 3 -X POST http://172.19.0.1:54981/rest/v1/rpc/me)" != 401 ]]; then
  restore
  printf 'Preview services did not become ready.\n' >&2
  exit 1
fi
switch_link ".mobile-preview-releases/$version" "$web/mobile-preview"

if ! cmp -s "$backup" "$candidate"; then
  cat "$candidate" > "$caddy"
  if ! docker exec "$front" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
    cat "$backup" > "$caddy"
    docker exec "$front" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
    restore
    exit 1
  fi
fi
systemctl enable bron-mobile-preview-api.service bron-mobile-preview-gate.service
printf 'Preview source %s is running at %s\n' "$version" "$public_origin"
