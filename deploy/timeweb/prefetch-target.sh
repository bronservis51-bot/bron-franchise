#!/usr/bin/env bash
# Cache the reviewed target stack on the owner's existing Russian VPS.
# No database connections, application containers, public ports, DNS or purchases.
set -Eeuo pipefail
umask 077
fail() { printf 'STOP: %s\n' "$*" >&2; exit 1; }
case "${1-}" in
  --check|--prepare) mode=$1 ;;
  --help) printf '%s\n' 'Usage: bash prefetch-target.sh --check|--prepare'; exit 0 ;;
  *) fail 'Use --check or --prepare explicitly.' ;;
esac
[[ $EUID == 0 ]] || fail 'Run only as root on the verified target VPS.'
ip -4 -o addr show scope global | awk '{sub(/\/.*/, "", $4); print $4}' |
  grep -Fqx '152.228.115.115' || fail 'Unexpected target IP.'
[[ ! -e /opt/bron/production-enabled ]] || fail 'Production preparation forbidden.'
[[ -z $(docker ps --all --quiet) ]] || fail 'Review existing containers first.'
systemctl is-active --quiet docker ssh || fail 'Docker/SSH must be active.'
for executable in git curl openssl python3; do command -v "$executable" >/dev/null || fail "Missing $executable"; done
available_kb=$(df -Pk / | awk 'NR == 2 {print $4}')
(( available_kb >= 16 * 1024 * 1024 )) || fail 'Need at least 16 GiB free.'
printf '%s\n' 'Target cache preflight passed.'
[[ $mode == --prepare ]] || exit 0

install -d -m 0700 /opt/bron
log=/var/log/bron-target-prefetch.log
touch "$log"; chmod 0600 "$log"
exec > >(tee -a "$log") 2>&1
trap 'status=$?; printf "Target preparation stopped at line %s (exit %s). No release performed.\n" "$LINENO" "$status"; exit "$status"' ERR

checkout=/opt/bron/supabase
upstream=0ed90ae4603ff58f6e170fed51ea23bbda11cf6f
if [[ ! -e $checkout ]]; then
  install -d -m 0700 "$checkout"
  git -C "$checkout" init --quiet
  git -C "$checkout" remote add origin https://github.com/supabase/supabase.git
fi
[[ -d $checkout/.git ]] || fail 'Existing checkout needs review.'
[[ $(git -C "$checkout" remote get-url origin) == https://github.com/supabase/supabase.git ]] || fail 'Unexpected upstream remote.'
[[ -z $(git -C "$checkout" status --porcelain --untracked-files=no) ]] || fail 'Upstream checkout has local changes.'
git -C "$checkout" sparse-checkout init --cone
git -C "$checkout" sparse-checkout set docker
git -C "$checkout" fetch --filter=blob:none --depth=1 origin "$upstream"
git -C "$checkout" checkout --quiet --detach FETCH_HEAD
[[ $(git -C "$checkout" rev-parse HEAD) == "$upstream" ]] || fail 'Unexpected upstream revision.'
[[ ! -e $checkout/docker/.env ]] || fail 'Do not replace configured installations.'
install -d -m 0700 "$checkout/docker/bron"

download_verified() {
  local url=$1 destination=$2 expected=$3 temporary
  temporary=$(mktemp /opt/bron/download.XXXXXX)
  curl --fail --show-error --location --proto '=https' --max-time 120 "$url" -o "$temporary"
  printf '%s  %s\n' "$expected" "$temporary" | sha256sum --check --strict
  install -m 0600 "$temporary" "$destination"
  rm -f "$temporary"
}
# A content hash prevents a changed branch from supplying unreviewed files.
own_base=https://raw.githubusercontent.com/bronservis51-bot/bron-franchise/ops/russia-migration-20261110/deploy/timeweb
download_verified "$own_base/compose.override.yml" "$checkout/docker/bron/compose.override.yml" a83fbde612c11b9e37b1760dc670760b7e8d94d045b91e9d9f9d2c4b70f7ba4a
download_verified "$own_base/Caddyfile" "$checkout/docker/bron/Caddyfile" aa2f88e90b8eb54191d53448561f87fe990b4f31a03dfa19dc2872e7e7a80acd
download_verified "$own_base/source-db-access.py" /opt/bron/source-db-access.py cb30b24e4aa44083a9b44638eaf2248e17d94f57a28bec63ac39cf1660b3cfd0
download_verified https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt /opt/bron/source-ca.crt 700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7
openssl x509 -in /opt/bron/source-ca.crt -noout -checkend 86400 >/dev/null
cat /etc/ssl/certs/ca-certificates.crt /opt/bron/source-ca.crt > /opt/bron/source-ca-bundle.pem
chmod 0600 /opt/bron/source-ca-bundle.pem

cd "$checkout/docker"
# Public upstream example values are used only for configuration validation.
# They are NOT copied to .env and no service is started with them.
docker compose --env-file .env.example -f docker-compose.yml -f bron/compose.override.yml config --images |
  sort -u > /opt/bron/target-image-list.txt
grep -Fqx 'supabase/postgres:17.11.0.019@sha256:eca9f664ced0c453ae499e75bb503283831c94f2eef69fc2e69bf86f70278ddc' /opt/bron/target-image-list.txt || fail 'Patched database override missing.'
while IFS= read -r image; do
  [[ $image != *:latest ]] || fail 'Mutable latest tag is forbidden.'
  docker pull --quiet "$image"
done < /opt/bron/target-image-list.txt
{
  date -u --iso-8601=seconds
  printf 'upstream=%s\n' "$upstream"
  cat /opt/bron/target-image-list.txt
} > /opt/bron/target-cache-manifest.txt
printf '%s\n' 'Target files, verified source CA and images cached.'
printf '%s\n' 'No application containers started, database copied or DNS switched.'
