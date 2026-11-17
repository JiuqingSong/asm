#!/usr/bin/env bash
# Sets up AsmPerfect 86 on the family server (Ubuntu with Docker): builds and starts the
# container. Safe to run again. The repo must be a clone (README), so update-server.sh can pull.
#
#   ~/asmperfect/deploy/setup-server.sh
set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\n==> %s\n' "$*"; }

if ! command -v docker >/dev/null; then
    echo "Docker isn't installed; set up the family server first (songchat's deploy/setup-server.sh)." >&2
    exit 1
fi

step "Settings (.env)"
cat > .env <<ENV
ASMPERFECT_UID=$(id -u)
ASMPERFECT_GID=$(id -g)
ENV

step "Build and start"
./update-server.sh --no-pull
printf '\nAsmPerfect 86 is running: http://%s:8075/\n' "$(hostname -I | awk '{print $1}')"
