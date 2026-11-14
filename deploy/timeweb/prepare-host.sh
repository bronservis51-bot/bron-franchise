#!/usr/bin/env bash
# Preparation only, on the owner's new AdminVPS service 386078.
# No database connections, application containers, credentials or DNS changes.
# Sources: docs.docker.com/engine/install/ubuntu/,
# postgresql.org/download/linux/ubuntu/, github.com/supabase/cli/releases/tag/v3.1.0.
set -Eeuo pipefail
umask 077

usage() { printf '%s\n' 'Usage: bash prepare-host.sh --check|--prepare'; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
case "${1-}" in
  --help) usage; exit 0 ;;
  --check|--prepare) mode=$1 ;;
  *) usage >&2; exit 2 ;;
esac

[[ $EUID == 0 ]] || fail 'Run only as root on the verified target VPS.'
# shellcheck source=/dev/null
. /etc/os-release
[[ ${ID-} == ubuntu && ${VERSION_ID-} == 24.04 ]] || fail 'Expected Ubuntu 24.04.'
[[ $(dpkg --print-architecture) == amd64 ]] || fail 'Expected amd64.'
ip -4 -o addr show scope global | awk '{sub(/\/.*/, "", $4); print $4}' |
  grep -Fqx '152.228.115.115' || fail 'Target IP does not match the verified VPS.'
[[ ! -e /opt/bron/production-enabled ]] || fail 'Production preparation is forbidden.'
available_kb=$(df -Pk / | awk 'NR == 2 {print $4}')
[[ $available_kb =~ ^[0-9]+$ ]] || fail 'Cannot determine free disk space.'
(( available_kb >= 16 * 1024 * 1024 )) || fail 'Need at least 16 GiB free.'
if command -v docker >/dev/null 2>&1; then
  containers=$(docker ps --all --quiet) || fail 'Cannot inspect existing Docker state.'
  [[ -z $containers ]] || fail 'Existing containers require a separate review.'
fi
printf '%s\n' 'Target preflight passed.'
[[ $mode == --prepare ]] || exit 0

install -d -m 0700 /root/bron-secrets /var/backups/bron-franchise /opt/bron
install -d -m 0755 /etc/apt/keyrings
log=/var/log/bron-host-prepare.log
touch "$log"
chmod 0600 "$log"
exec > >(tee -a "$log") 2>&1
trap 'status=$?; printf "Preparation failed at line %s (exit %s). No release performed.\n" "$LINENO" "$status"; exit "$status"' ERR
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
apt=(apt-get -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confold)
"${apt[@]}" update
"${apt[@]}" install -y ca-certificates curl gnupg git jq age unzip zstd

curl --fail --show-error --location --proto '=https' \
  https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<'EOF'
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF

curl --fail --show-error --location --proto '=https' \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /etc/apt/keyrings/postgresql.asc
chmod 0644 /etc/apt/keyrings/postgresql.asc
cat > /etc/apt/sources.list.d/postgresql.sources <<'EOF'
Types: deb
URIs: https://apt.postgresql.org/pub/repos/apt
Suites: noble-pgdg
Components: main
Architectures: amd64
Signed-By: /etc/apt/keyrings/postgresql.asc
EOF

"${apt[@]}" update
docker_version=$(apt-cache policy docker-ce | awk '/Candidate:/ {print $2}')
[[ -n $docker_version && $docker_version != '(none)' ]] || fail 'No Docker candidate.'
"${apt[@]}" install -y "docker-ce=$docker_version" "docker-ce-cli=$docker_version" \
  containerd.io docker-buildx-plugin docker-compose-plugin postgresql-client-17
systemctl enable --now docker
docker info >/dev/null
compose_version=$(docker compose version --short)
dpkg --compare-versions "${compose_version#v}" ge 2.24.4 || fail 'Compose is too old.'

tmp=$(mktemp -d /root/bron-cli.XXXXXX)
trap 'rm -f "$tmp/supabase.deb"; rmdir "$tmp"' EXIT
curl --fail --show-error --location --proto '=https' \
  https://github.com/supabase/cli/releases/download/v3.1.0/supabase_3.1.0_linux_amd64.deb \
  -o "$tmp/supabase.deb"
printf '%s  %s\n' '1b303dbf23ab2ace5abc18ca64b6bb74198f034035fd492b9bddade96a88bf72' \
  "$tmp/supabase.deb" | sha256sum --check --strict
dpkg -i "$tmp/supabase.deb"
[[ $(supabase --version) == 3.1.0 ]] || fail 'Unexpected Supabase CLI version.'
pg_dump --version | grep -Eq '^pg_dump \(PostgreSQL\) 17\.' || fail 'Expected pg_dump 17.'

{
  date -u --iso-8601=seconds
  docker --version
  docker compose version
  pg_dump --version
  supabase --version
  dpkg-query -W docker-ce docker-ce-cli containerd.io docker-compose-plugin postgresql-client-17
} > /opt/bron/host-versions.txt
chmod 0600 /opt/bron/host-versions.txt
printf '%s\n' 'Host tools prepared. No database copied and no application released.'
if [[ -f /var/run/reboot-required ]]; then
  printf '%s\n' 'A reboot is required before migrating personal data.'
fi
