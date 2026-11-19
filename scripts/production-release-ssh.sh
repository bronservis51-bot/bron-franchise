#!/bin/sh
# Installed as root-owned /usr/local/sbin/bron-release-ssh under an SSH forced command.
set -eu
[ "$#" -eq 0 ] && [ "${SSH_ORIGINAL_COMMAND:-}" = bron-release-v1 ] || exit 64
exec /usr/bin/sudo -n /usr/local/sbin/bron-production-release
